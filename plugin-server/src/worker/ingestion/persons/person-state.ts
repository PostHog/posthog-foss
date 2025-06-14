import { PluginEvent, Properties } from '@posthog/plugin-scaffold'
import LRU from 'lru-cache'
import { DateTime } from 'luxon'
import { Counter, Histogram } from 'prom-client'

import { ONE_HOUR } from '../../../config/constants'
import { KafkaProducerWrapper } from '../../../kafka/producer'
import { InternalPerson, Person, PropertyUpdateOperation, Team } from '../../../types'
import { TransactionClient } from '../../../utils/db/postgres'
import { eventToPersonProperties, initialEventToPersonProperties, timeoutGuard } from '../../../utils/db/utils'
import { logger } from '../../../utils/logger'
import { captureException } from '../../../utils/posthog'
import { promiseRetry } from '../../../utils/retries'
import { uuidFromDistinctId } from '../person-uuid'
import { captureIngestionWarning } from '../utils'
import { applyEventPropertyUpdates, applyEventPropertyUpdatesOptimized } from './person-update'
import { PersonsStoreForBatch } from './persons-store-for-batch'

export const mergeFinalFailuresCounter = new Counter({
    name: 'person_merge_final_failure_total',
    help: 'Number of person merge final failures.',
})

export const mergeTxnAttemptCounter = new Counter({
    name: 'person_merge_txn_attempt_total',
    help: 'Number of person merge attempts.',
    labelNames: ['call', 'oldPersonIdentified', 'newPersonIdentified'],
})

export const mergeTxnSuccessCounter = new Counter({
    name: 'person_merge_txn_success_total',
    help: 'Number of person merges that succeeded.',
    labelNames: ['call', 'oldPersonIdentified', 'newPersonIdentified'],
})

// temporary: for fetchPerson properties JSONB size observation
const ONE_MEGABYTE_PROPS_BLOB = 1048576
const personPropertiesSize = new Histogram({
    name: 'person_properties_size',
    help: 'histogram of compressed person JSONB bytes retrieved in fetchPerson calls',
    labelNames: ['at'],
    // 1kb, 8kb, 64kb, 512kb, 1mb, 2mb, 4mb, 8mb, 16mb, 64mb, inf+
    buckets: [1024, 8192, 65536, 524288, 1048576, 2097152, 4194304, 8388608, 16777216, 67108864, Infinity],
})

// used to prevent identify from being used with generic IDs
// that we can safely assume stem from a bug or mistake
// used to prevent identify from being used with generic IDs
// that we can safely assume stem from a bug or mistake
const BARE_CASE_INSENSITIVE_ILLEGAL_IDS = [
    'anonymous',
    'guest',
    'distinctid',
    'distinct_id',
    'id',
    'not_authenticated',
    'email',
    'undefined',
    'true',
    'false',
]

// Tracks whether we know we've already inserted a `posthog_personlessdistinctid` for the given
// (team_id, distinct_id) pair. If we have, then we can skip the INSERT attempt.
// TODO: Move this out of module scope, we don't currently have a clean place (outside of the Hub)
// to stash longer lived objects like caches. For now it's not important.
const PERSONLESS_DISTINCT_ID_INSERTED_CACHE = new LRU<string, boolean>({
    max: 10_000,
    maxAge: ONE_HOUR * 24, // cache up to 24h
    updateAgeOnGet: true,
})

const BARE_CASE_SENSITIVE_ILLEGAL_IDS = ['[object Object]', 'NaN', 'None', 'none', 'null', '0', 'undefined']

// we have seen illegal ids received but wrapped in double quotes
// to protect ourselves from this we'll add the single- and double-quoted versions of the illegal ids
const singleQuoteIds = (ids: string[]) => ids.map((id) => `'${id}'`)
const doubleQuoteIds = (ids: string[]) => ids.map((id) => `"${id}"`)

// some ids are illegal regardless of casing
// while others are illegal only when cased
// so, for example, we want to forbid `NaN` but not `nan`
// but, we will forbid `uNdEfInEd` and `undefined`
const CASE_INSENSITIVE_ILLEGAL_IDS = new Set(
    BARE_CASE_INSENSITIVE_ILLEGAL_IDS.concat(singleQuoteIds(BARE_CASE_INSENSITIVE_ILLEGAL_IDS)).concat(
        doubleQuoteIds(BARE_CASE_INSENSITIVE_ILLEGAL_IDS)
    )
)

const CASE_SENSITIVE_ILLEGAL_IDS = new Set(
    BARE_CASE_SENSITIVE_ILLEGAL_IDS.concat(singleQuoteIds(BARE_CASE_SENSITIVE_ILLEGAL_IDS)).concat(
        doubleQuoteIds(BARE_CASE_SENSITIVE_ILLEGAL_IDS)
    )
)

export const isDistinctIdIllegal = (id: string): boolean => {
    const trimmed = id.trim()
    return trimmed === '' || CASE_INSENSITIVE_ILLEGAL_IDS.has(id.toLowerCase()) || CASE_SENSITIVE_ILLEGAL_IDS.has(id)
}

// This class is responsible for creating/updating a single person through the process-event pipeline
export class PersonState {
    private eventProperties: Properties

    public updateIsIdentified: boolean // TODO: remove this from the class and being hidden

    constructor(
        private event: PluginEvent,
        private team: Team,
        private distinctId: string,
        private timestamp: DateTime,
        private processPerson: boolean, // $process_person_profile flag from the event
        private kafkaProducer: KafkaProducerWrapper,
        private personStore: PersonsStoreForBatch,
        private measurePersonJsonbSize: number = 0,
        private useOptimizedJSONBUpdates: number = 0.0
    ) {
        this.eventProperties = event.properties!

        // If set to true, we'll update `is_identified` at the end of `updateProperties`
        // :KLUDGE: This is an indirect communication channel between `handleIdentifyOrAlias` and `updateProperties`
        this.updateIsIdentified = false
    }

    private async capturePersonPropertiesSizeEstimate(at: string): Promise<void> {
        if (Math.random() >= this.measurePersonJsonbSize) {
            // no-op if env flag is set to 0 (default) otherwise rate-limit
            // ramp up of expensive size checking while we test it
            return
        }

        const estimatedBytes: number = await this.personStore.personPropertiesSize(this.team.id, this.distinctId)
        personPropertiesSize.labels({ at: at }).observe(estimatedBytes)

        // if larger than size threshold (start conservative, adjust as we observe)
        // we should log the team and disinct_id associated with the properties
        if (estimatedBytes >= ONE_MEGABYTE_PROPS_BLOB) {
            logger.warn('⚠️', 'record with oversized person properties detected', {
                teamId: this.team.id,
                distinctId: this.distinctId,
                called_at: at,
                estimated_bytes: estimatedBytes,
            })
        }

        return
    }

    async update(): Promise<[Person, Promise<void>]> {
        if (!this.processPerson) {
            let existingPerson = await this.personStore.fetchForChecking(this.team.id, this.distinctId)

            if (!existingPerson) {
                // See the comment in `mergeDistinctIds`. We are inserting a row into `posthog_personlessdistinctid`
                // to note that this Distinct ID has been used in "personless" mode. This is necessary
                // so that later, during a merge, we can decide whether we need to write out an override
                // or not.

                const personlessDistinctIdCacheKey = `${this.team.id}|${this.distinctId}`
                if (!PERSONLESS_DISTINCT_ID_INSERTED_CACHE.get(personlessDistinctIdCacheKey)) {
                    const personIsMerged = await this.personStore.addPersonlessDistinctId(this.team.id, this.distinctId)

                    // We know the row is in PG now, and so future events for this Distinct ID can
                    // skip the PG I/O.
                    PERSONLESS_DISTINCT_ID_INSERTED_CACHE.set(personlessDistinctIdCacheKey, true)

                    if (personIsMerged) {
                        // If `personIsMerged` comes back `true`, it means the `posthog_personlessdistinctid`
                        // has been updated by a merge (either since we called `fetchPerson` above, plus
                        // replication lag). We need to check `fetchPerson` again (this time using the leader)
                        // so that we properly associate this event with the Person we got merged into.
                        existingPerson = await this.personStore.fetchForUpdate(this.team.id, this.distinctId)
                    }
                }
            }

            if (existingPerson) {
                const person = existingPerson as Person

                // Ensure person properties don't propagate elsewhere, such as onto the event itself.
                person.properties = {}

                // If the team has opted out then we never force the upgrade.
                const teamHasNotOptedOut = !this.team.person_processing_opt_out

                if (teamHasNotOptedOut && this.timestamp > person.created_at.plus({ minutes: 1 })) {
                    // See documentation on the field.
                    //
                    // Note that we account for timestamp vs person creation time (with a little
                    // padding for good measure) to account for ingestion lag. It's possible for
                    // events to be processed after person creation even if they were sent prior
                    // to person creation, and the user did nothing wrong in that case.
                    person.force_upgrade = true
                }

                return [person, Promise.resolve()]
            }

            // We need a value from the `person_created_column` in ClickHouse. This should be
            // hidden from users for events without a real person, anyway. It's slightly offset
            // from the 0 date (by 5 seconds) in order to assist in debugging by being
            // harmlessly distinct from Unix UTC "0".
            const createdAt = DateTime.utc(1970, 1, 1, 0, 0, 5)

            const fakePerson: Person = {
                team_id: this.team.id,
                properties: {},
                uuid: uuidFromDistinctId(this.team.id, this.distinctId),
                created_at: createdAt,
            }
            return [fakePerson, Promise.resolve()]
        }

        const [person, identifyOrAliasKafkaAck]: [InternalPerson | undefined, Promise<void>] =
            await this.handleIdentifyOrAlias() // TODO: make it also return a boolean for if we can exit early here

        if (person) {
            // try to shortcut if we have the person from identify or alias
            try {
                const [updatedPerson, updateKafkaAck] = await this.updatePersonProperties(person)
                return [updatedPerson, Promise.all([identifyOrAliasKafkaAck, updateKafkaAck]).then(() => undefined)]
            } catch (error) {
                // shortcut didn't work, swallow the error and try normal retry loop below
                logger.debug('🔁', `failed update after adding distinct IDs, retrying`, { error })
            }
        }

        const [updatedPerson, updateKafkaAck] = await this.handleUpdate()
        return [updatedPerson, Promise.all([identifyOrAliasKafkaAck, updateKafkaAck]).then(() => undefined)]
    }

    async handleUpdate(): Promise<[InternalPerson, Promise<void>]> {
        // There are various reasons why update can fail:
        // - another thread created the person during a race
        // - the person might have been merged between start of processing and now
        // we simply and stupidly start from scratch
        return await promiseRetry(() => this.updateProperties(), 'update_person')
    }

    async updateProperties(): Promise<[InternalPerson, Promise<void>]> {
        const [person, propertiesHandled] = await this.createOrGetPerson()
        if (propertiesHandled) {
            return [person, Promise.resolve()]
        }
        if (Math.random() < this.useOptimizedJSONBUpdates) {
            return await this.updatePersonPropertiesOptimized(person)
        } else {
            return await this.updatePersonProperties(person)
        }
    }

    /**
     * @returns [Person, boolean that indicates if properties were already handled or not]
     */
    private async createOrGetPerson(): Promise<[InternalPerson, boolean]> {
        await this.capturePersonPropertiesSizeEstimate('createOrGetPerson')

        let person = await this.personStore.fetchForUpdate(this.team.id, this.distinctId)
        if (person) {
            return [person, false]
        }

        let properties = {}
        let propertiesOnce = {}
        if (this.processPerson) {
            properties = this.eventProperties['$set']
            propertiesOnce = this.eventProperties['$set_once']
        }

        person = await this.createPerson(
            this.timestamp,
            properties || {},
            propertiesOnce || {},
            this.team.id,
            null,
            // :NOTE: This should never be set in this branch, but adding this for logical consistency
            this.updateIsIdentified,
            this.event.uuid,
            [{ distinctId: this.distinctId }]
        )
        return [person, true]
    }

    private async createPerson(
        createdAt: DateTime,
        properties: Properties,
        propertiesOnce: Properties,
        teamId: number,
        isUserId: number | null,
        isIdentified: boolean,
        creatorEventUuid: string,
        distinctIds: { distinctId: string; version?: number }[],
        tx?: TransactionClient
    ): Promise<InternalPerson> {
        if (distinctIds.length < 1) {
            throw new Error('at least 1 distinctId is required in `createPerson`')
        }
        const uuid = uuidFromDistinctId(teamId, distinctIds[0].distinctId)

        const props = { ...propertiesOnce, ...properties, ...{ $creator_event_uuid: creatorEventUuid } }
        const propertiesLastOperation: Record<string, any> = {}
        const propertiesLastUpdatedAt: Record<string, any> = {}
        Object.keys(propertiesOnce).forEach((key) => {
            propertiesLastOperation[key] = PropertyUpdateOperation.SetOnce
            propertiesLastUpdatedAt[key] = createdAt
        })
        Object.keys(properties).forEach((key) => {
            propertiesLastOperation[key] = PropertyUpdateOperation.Set
            propertiesLastUpdatedAt[key] = createdAt
        })

        const [person, kafkaMessages] = await this.personStore.createPerson(
            createdAt,
            props,
            propertiesLastUpdatedAt,
            propertiesLastOperation,
            teamId,
            isUserId,
            isIdentified,
            uuid,
            distinctIds,
            tx
        )

        await this.kafkaProducer.queueMessages(kafkaMessages)
        return person
    }

    private async updatePersonPropertiesOptimized(person: InternalPerson): Promise<[InternalPerson, Promise<void>]> {
        person.properties ||= {}

        const propertyUpdate = applyEventPropertyUpdatesOptimized(this.event, person.properties)

        const otherUpdates: Partial<InternalPerson> = {}
        if (this.updateIsIdentified && !person.is_identified) {
            otherUpdates.is_identified = true
        }

        const hasPropertyChanges =
            propertyUpdate.hasChanges &&
            (Object.keys(propertyUpdate.toSet).length > 0 || propertyUpdate.toUnset.length > 0)
        const hasOtherChanges = Object.keys(otherUpdates).length > 0

        if (hasPropertyChanges || hasOtherChanges) {
            const [updatedPerson, kafkaMessages] = await this.personStore.updatePersonWithPropertiesDiffForUpdate(
                person,
                propertyUpdate.toSet,
                propertyUpdate.toUnset,
                otherUpdates,
                this.distinctId
            )
            const kafkaAck = this.kafkaProducer.queueMessages(kafkaMessages)
            return [updatedPerson, kafkaAck]
        }

        return [person, Promise.resolve()]
    }

    private async updatePersonProperties(person: InternalPerson): Promise<[InternalPerson, Promise<void>]> {
        person.properties ||= {}

        const update: Partial<InternalPerson> = {}
        if (applyEventPropertyUpdates(this.event, person.properties)) {
            update.properties = person.properties
        }
        if (this.updateIsIdentified && !person.is_identified) {
            update.is_identified = true
        }

        if (Object.keys(update).length > 0) {
            const [updatedPerson, kafkaMessages] = await this.personStore.updatePersonForUpdate(
                person,
                update,
                this.distinctId
            )
            const kafkaAck = this.kafkaProducer.queueMessages(kafkaMessages)
            return [updatedPerson, kafkaAck]
        }

        return [person, Promise.resolve()]
    }

    // For tracking what property keys cause us to update persons
    // tracking all properties we add from the event, 'geoip' for '$geoip_*' or '$initial_geoip_*' and 'other' for anything outside of those
    private getMetricKey(key: string): string {
        if (key.startsWith('$geoip_') || key.startsWith('$initial_geoip_')) {
            return 'geoIP'
        }
        if (eventToPersonProperties.has(key)) {
            return key
        }
        if (initialEventToPersonProperties.has(key)) {
            return key
        }
        return 'other'
    }

    // Alias & merge

    async handleIdentifyOrAlias(): Promise<[InternalPerson | undefined, Promise<void>]> {
        /**
         * strategy:
         *   - if the two distinct ids passed don't match and aren't illegal, then mark `is_identified` to be true for the `distinct_id` person
         *   - if a person doesn't exist for either distinct id passed we create the person with both ids
         *   - if only one person exists we add the other distinct id
         *   - if the distinct ids belong to different already existing persons we try to merge them:
         *     - the merge is blocked if the other distinct id (`anon_distinct_id` or `alias` event property) person has `is_identified` true.
         *     - we merge into `distinct_id` person:
         *       - both distinct ids used in the future will map to the person id that was associated with `distinct_id` before
         *       - if person property was defined for both we'll use `distinct_id` person's property going forward
         */
        const timeout = timeoutGuard('Still running "handleIdentifyOrAlias". Timeout warning after 30 sec!')
        try {
            if (['$create_alias', '$merge_dangerously'].includes(this.event.event) && this.eventProperties['alias']) {
                return await this.merge(
                    String(this.eventProperties['alias']),
                    this.distinctId,
                    this.team.id,
                    this.timestamp
                )
            } else if (this.event.event === '$identify' && '$anon_distinct_id' in this.eventProperties) {
                return await this.merge(
                    String(this.eventProperties['$anon_distinct_id']),
                    this.distinctId,
                    this.team.id,
                    this.timestamp
                )
            }
        } catch (e) {
            captureException(e, {
                tags: { team_id: this.team.id, pipeline_step: 'processPersonsStep' },
                extra: {
                    location: 'handleIdentifyOrAlias',
                    distinctId: this.distinctId,
                    anonId: String(this.eventProperties['$anon_distinct_id']),
                    alias: String(this.eventProperties['alias']),
                },
            })
            mergeFinalFailuresCounter.inc()
            console.error('handleIdentifyOrAlias failed', e, this.event)
        } finally {
            clearTimeout(timeout)
        }
        return [undefined, Promise.resolve()]
    }

    public async merge(
        otherPersonDistinctId: string,
        mergeIntoDistinctId: string,
        teamId: number,
        timestamp: DateTime
    ): Promise<[InternalPerson | undefined, Promise<void>]> {
        // No reason to alias person against itself. Done by posthog-node when updating user properties
        if (mergeIntoDistinctId === otherPersonDistinctId) {
            return [undefined, Promise.resolve()]
        }
        if (isDistinctIdIllegal(mergeIntoDistinctId)) {
            await captureIngestionWarning(
                this.kafkaProducer,
                teamId,
                'cannot_merge_with_illegal_distinct_id',
                {
                    illegalDistinctId: mergeIntoDistinctId,
                    otherDistinctId: otherPersonDistinctId,
                    eventUuid: this.event.uuid,
                },
                { alwaysSend: true }
            )
            return [undefined, Promise.resolve()]
        }
        if (isDistinctIdIllegal(otherPersonDistinctId)) {
            await captureIngestionWarning(
                this.kafkaProducer,
                teamId,
                'cannot_merge_with_illegal_distinct_id',
                {
                    illegalDistinctId: otherPersonDistinctId,
                    otherDistinctId: mergeIntoDistinctId,
                    eventUuid: this.event.uuid,
                },
                { alwaysSend: true }
            )
            return [undefined, Promise.resolve()]
        }
        return promiseRetry(
            () => this.mergeDistinctIds(otherPersonDistinctId, mergeIntoDistinctId, teamId, timestamp),
            'merge_distinct_ids'
        )
    }

    private async mergeDistinctIds(
        otherPersonDistinctId: string,
        mergeIntoDistinctId: string,
        teamId: number,
        timestamp: DateTime
    ): Promise<[InternalPerson, Promise<void>]> {
        this.updateIsIdentified = true

        await this.capturePersonPropertiesSizeEstimate('mergeDistinctIds_other')
        const otherPerson = await this.personStore.fetchForUpdate(teamId, otherPersonDistinctId)

        await this.capturePersonPropertiesSizeEstimate('mergeDistinctIds_into')
        const mergeIntoPerson = await this.personStore.fetchForUpdate(teamId, mergeIntoDistinctId)

        // A note about the `distinctIdVersion` logic you'll find below:
        //
        // Historically, we always INSERT-ed new `posthog_persondistinctid` rows with `version=0`.
        // Overrides are only created when the version is > 0, see:
        //   https://github.com/PostHog/posthog/blob/92e17ce307a577c4233d4ab252eebc6c2207a5ee/posthog/models/person/sql.py#L269-L287
        //
        // With the addition of optional person profile processing, we are no longer creating
        // `posthog_persondistinctid` and `posthog_person` rows when $process_person_profile=false.
        // This means that at merge time, it's possible this `distinct_id` and its deterministically
        // generated `person.uuid` has already been used for events in ClickHouse, but they have no
        // corresponding rows in the `posthog_persondistinctid` or `posthog_person` tables.
        //
        // For this reason, $process_person_profile=false write to the `posthog_personlessdistinctid`
        // table just to note that a given Distinct ID was used for "personless" mode. Then, during
        // our merges transactions below, we do two things:
        //   1. We check whether a row exists in `posthog_personlessdistinctid` for that Distinct ID,
        //      if so, we need to write out `posthog_persondistinctid` rows with `version=1` so that
        //      an override is created in ClickHouse which will associate the old "personless" events
        //      with the Person UUID they were merged into.
        //   2. We insert and/or update the `posthog_personlessdistinctid` ourselves, to mark that
        //      the Distinct ID has been merged. This is important so that an event being processed
        //      concurrently for that Distinct ID doesn't emit an event and _miss_ that a different
        //      Person UUID needs to be used now. (See the `processPerson` code in `update` for more.)

        if ((otherPerson && !mergeIntoPerson) || (!otherPerson && mergeIntoPerson)) {
            // Only one of the two Distinct IDs points at an existing Person

            const [existingPerson, distinctIdToAdd] = (() => {
                if (otherPerson) {
                    return [otherPerson!, mergeIntoDistinctId]
                } else {
                    return [mergeIntoPerson!, otherPersonDistinctId]
                }
            })()

            return await this.personStore.inTransaction('mergeDistinctIds-OneExists', async (tx) => {
                // See comment above about `distinctIdVersion`
                const insertedDistinctId = await this.personStore.addPersonlessDistinctIdForMerge(
                    this.team.id,
                    distinctIdToAdd,
                    tx
                )
                const distinctIdVersion = insertedDistinctId ? 0 : 1

                const kafkaMessages = await this.personStore.addDistinctId(
                    existingPerson,
                    distinctIdToAdd,
                    distinctIdVersion,
                    tx
                )
                await this.kafkaProducer.queueMessages(kafkaMessages)
                return [existingPerson, Promise.resolve()]
            })
        } else if (otherPerson && mergeIntoPerson) {
            // Both Distinct IDs point at an existing Person

            if (otherPerson.id == mergeIntoPerson.id) {
                // Nothing to do, they are the same Person
                return [mergeIntoPerson, Promise.resolve()]
            }

            return await this.mergePeople({
                mergeInto: mergeIntoPerson,
                mergeIntoDistinctId: mergeIntoDistinctId,
                otherPerson: otherPerson,
                otherPersonDistinctId: otherPersonDistinctId,
            })
        } else {
            // Neither Distinct ID points at an existing Person

            let distinctId1 = mergeIntoDistinctId
            let distinctId2 = otherPersonDistinctId

            return await this.personStore.inTransaction('mergeDistinctIds-NeitherExist', async (tx) => {
                // See comment above about `distinctIdVersion`
                const insertedDistinctId1 = await this.personStore.addPersonlessDistinctIdForMerge(
                    this.team.id,
                    distinctId1,
                    tx
                )

                // See comment above about `distinctIdVersion`
                const insertedDistinctId2 = await this.personStore.addPersonlessDistinctIdForMerge(
                    this.team.id,
                    distinctId2,
                    tx
                )

                // `createPerson` uses the first Distinct ID provided to generate the Person
                // UUID. That means the first Distinct ID definitely doesn't need an override,
                // and can always use version 0. Below, we exhaust all of the options to decide
                // whether we can optimize away an override by doing a swap, or whether we
                // need to actually write an override. (But mostly we're being verbose for
                // documentation purposes)
                let distinctId2Version = 0
                if (insertedDistinctId1 && insertedDistinctId2) {
                    // We were the first to insert both (neither was used for Personless), so we
                    // can use either as the primary Person UUID and create no overrides.
                } else if (insertedDistinctId1 && !insertedDistinctId2) {
                    // We created 1, but 2 was already used for Personless. Let's swap so
                    // that 2 can be the primary Person UUID and no override is needed.
                    ;[distinctId1, distinctId2] = [distinctId2, distinctId1]
                } else if (!insertedDistinctId1 && insertedDistinctId2) {
                    // We created 2, but 1 was already used for Personless, so we want to
                    // use 1 as the primary Person UUID so that no override is needed.
                } else if (!insertedDistinctId1 && !insertedDistinctId2) {
                    // Both were used in Personless mode, so there is no more-correct choice of
                    // primary Person UUID to make here, and we need to drop an override by
                    // using version = 1 for Distinct ID 2.
                    distinctId2Version = 1
                }

                // The first Distinct ID is used to create the new Person's UUID, and so it
                // never needs an override.
                const distinctId1Version = 0

                return [
                    await this.createPerson(
                        // TODO: in this case we could skip the properties updates later
                        timestamp,
                        this.eventProperties['$set'] || {},
                        this.eventProperties['$set_once'] || {},
                        teamId,
                        null,
                        true,
                        this.event.uuid,
                        [
                            { distinctId: distinctId1, version: distinctId1Version },
                            { distinctId: distinctId2, version: distinctId2Version },
                        ],
                        tx
                    ),
                    Promise.resolve(),
                ]
            })
        }
    }

    public async mergePeople({
        mergeInto,
        mergeIntoDistinctId,
        otherPerson,
        otherPersonDistinctId,
    }: {
        mergeInto: InternalPerson
        mergeIntoDistinctId: string
        otherPerson: InternalPerson
        otherPersonDistinctId: string
    }): Promise<[InternalPerson, Promise<void>]> {
        const olderCreatedAt = DateTime.min(mergeInto.created_at, otherPerson.created_at)
        const mergeAllowed = this.isMergeAllowed(otherPerson)

        // If merge isn't allowed, we will ignore it, log an ingestion warning and exit
        if (!mergeAllowed) {
            await captureIngestionWarning(
                this.kafkaProducer,
                this.team.id,
                'cannot_merge_already_identified',
                {
                    sourcePersonDistinctId: otherPersonDistinctId,
                    targetPersonDistinctId: mergeIntoDistinctId,
                    eventUuid: this.event.uuid,
                },
                { alwaysSend: true }
            )
            logger.warn('🤔', 'refused to merge an already identified user via an $identify or $create_alias call')
            return [mergeInto, Promise.resolve()] // We're returning the original person tied to distinct_id used for the event
        }

        // How the merge works:
        // Merging properties:
        //   on key conflict we use the properties from the person provided as the first argument in identify or alias calls (mergeInto person),
        //   Note it's important for us to compute this before potentially swapping the persons for personID merging purposes in PoEEmbraceJoin mode
        // In case of PoE Embrace the join mode:
        //   we want to keep using the older person to reduce the number of partitions that need to be updated during squash
        //   to do that we'll swap otherPerson and mergeInto person (after properties merge computation!)
        //   additionally update person overrides table in postgres and clickhouse
        //   TODO: ^
        // If the merge fails:
        //   we'll roll back the transaction and then try from scratch in the origial order of persons provided for property merges
        //   that guarantees consistency of how properties are processed regardless of persons created_at timestamps and rollout state
        //   we're calling aliasDeprecated as we need to refresh the persons info completely first

        const properties: Properties = { ...otherPerson.properties, ...mergeInto.properties }
        applyEventPropertyUpdates(this.event, properties)

        const [mergedPerson, kafkaAcks] = await this.handleMergeTransaction(
            mergeInto,
            otherPerson,
            olderCreatedAt, // Keep the oldest created_at (i.e. the first time we've seen either person)
            properties
        )

        return [mergedPerson, kafkaAcks]
    }

    private isMergeAllowed(mergeFrom: InternalPerson): boolean {
        // $merge_dangerously has no restrictions
        // $create_alias and $identify will not merge a user who's already identified into anyone else
        return this.event.event === '$merge_dangerously' || !mergeFrom.is_identified
    }

    private async handleMergeTransaction(
        mergeInto: InternalPerson,
        otherPerson: InternalPerson,
        createdAt: DateTime,
        properties: Properties
    ): Promise<[InternalPerson, Promise<void>]> {
        mergeTxnAttemptCounter
            .labels({
                call: this.event.event, // $identify, $create_alias or $merge_dangerously
                oldPersonIdentified: String(otherPerson.is_identified),
                newPersonIdentified: String(mergeInto.is_identified),
            })
            .inc()

        const [mergedPerson, kafkaMessages] = await this.personStore.inTransaction('mergePeople', async (tx) => {
            const [person, updatePersonMessages] = await this.personStore.updatePersonForMerge(
                mergeInto,
                {
                    created_at: createdAt,
                    properties: properties,
                    is_identified: true,

                    // By using the max version between the two Persons, we ensure that if
                    // this Person is later split, we can use `this_person.version + 1` for
                    // any split-off Persons and know that *that* version will be higher than
                    // any previously deleted Person, and so the new Person row will "win" and
                    // "undelete" the Person.
                    //
                    // For example:
                    //  - Merge Person_1(version:7) into Person_2(version:2)
                    //      - Person_1 is deleted
                    //      - Person_2 attains version 8 via this code below
                    //  - Person_2 is later split, which attempts to re-create Person_1 by using
                    //    its `distinct_id` to generate the deterministic Person UUID.
                    //    That new Person_1 will have a version _at least_ as high as 8, and
                    //    so any previously existing rows in CH or otherwise from
                    //    Person_1(version:7) will "lose" to this new Person_1.
                    version: Math.max(mergeInto.version, otherPerson.version) + 1,
                },
                this.distinctId,
                tx
            )

            // Merge the distinct IDs
            // TODO: Doesn't this table need to add updates to CH too?
            await this.personStore.updateCohortsAndFeatureFlagsForMerge(
                otherPerson.team_id,
                otherPerson.id,
                mergeInto.id,
                this.distinctId,
                tx
            )

            const distinctIdMessages = await this.personStore.moveDistinctIds(
                otherPerson,
                mergeInto,
                this.distinctId,
                tx
            )

            const deletePersonMessages = await this.personStore.deletePerson(otherPerson, this.distinctId, tx)

            return [person, [...updatePersonMessages, ...distinctIdMessages, ...deletePersonMessages]]
        })

        mergeTxnSuccessCounter
            .labels({
                call: this.event.event, // $identify, $create_alias or $merge_dangerously
                oldPersonIdentified: String(otherPerson.is_identified),
                newPersonIdentified: String(mergeInto.is_identified),
            })
            .inc()

        const kafkaAck = this.kafkaProducer.queueMessages(kafkaMessages)

        return [mergedPerson, kafkaAck]
    }

    public async addDistinctId(
        person: InternalPerson,
        distinctId: string,
        version: number,
        tx?: TransactionClient
    ): Promise<void> {
        const kafkaMessages = await this.personStore.addDistinctId(person, distinctId, version, tx)
        await this.kafkaProducer.queueMessages(kafkaMessages)
    }
}
