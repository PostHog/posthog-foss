import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { ExportButton } from 'lib/components/ExportButton/ExportButton'
import { InsightLegend } from 'lib/components/InsightLegend/InsightLegend'
import { FEATURE_FLAGS } from 'lib/constants'
import { Tooltip } from 'lib/lemon-ui/Tooltip'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { Funnel } from 'scenes/funnels/Funnel'
import { FunnelCanvasLabel } from 'scenes/funnels/FunnelCanvasLabel'
import { funnelDataLogic } from 'scenes/funnels/funnelDataLogic'
import {
    FunnelSingleStepState,
    InsightEmptyState,
    InsightErrorState,
    InsightLoadingState,
    InsightTimeoutState,
    InsightValidationError,
} from 'scenes/insights/EmptyStates'
import { insightDataLogic } from 'scenes/insights/insightDataLogic'
import { insightLogic } from 'scenes/insights/insightLogic'
import { insightNavLogic } from 'scenes/insights/InsightNav/insightNavLogic'
import { insightVizDataLogic } from 'scenes/insights/insightVizDataLogic'
import { keyForInsightLogicProps } from 'scenes/insights/sharedUtils'
import { FunnelCorrelation } from 'scenes/insights/views/Funnels/FunnelCorrelation'
import { FunnelStepsTable } from 'scenes/insights/views/Funnels/FunnelStepsTable'
import { InsightsTable } from 'scenes/insights/views/InsightsTable/InsightsTable'
import { Paths } from 'scenes/paths/Paths'
import { PathCanvasLabel } from 'scenes/paths/PathsLabel'
import { PathsV2 } from 'scenes/paths-v2/PathsV2'
import { RetentionContainer } from 'scenes/retention/RetentionContainer'
import { TrendInsight } from 'scenes/trends/Trends'
import { InsightCalendarHeatMapContainer } from 'scenes/web-analytics/CalendarHeatMap/InsightCalendarHeatMapContainer'

import { QueryContext } from '~/queries/types'
import { ExporterFormat, FunnelVizType, InsightType, ItemMode } from '~/types'

import { InsightDisplayConfig } from './InsightDisplayConfig'
import { InsightResultMetadata } from './InsightResultMetadata'
import { ResultCustomizationsModal } from './ResultCustomizationsModal'
import { shouldQueryBeAsync } from '~/queries/utils'

export function InsightVizDisplay({
    disableHeader,
    disableTable,
    disableCorrelationTable,
    disableLastComputation,
    disableLastComputationRefresh,
    showingResults,
    insightMode,
    context,
    embedded,
    inSharedMode,
}: {
    disableHeader?: boolean
    disableTable?: boolean
    disableCorrelationTable?: boolean
    disableLastComputation?: boolean
    disableLastComputationRefresh?: boolean
    showingResults?: boolean
    insightMode?: ItemMode
    context?: QueryContext
    embedded: boolean
    inSharedMode?: boolean
}): JSX.Element | null {
    const { insightProps, canEditInsight, isUsingPathsV1, isUsingPathsV2 } = useValues(insightLogic)

    const { featureFlags } = useValues(featureFlagLogic)
    const { activeView } = useValues(insightNavLogic(insightProps))

    const { hasFunnelResults } = useValues(funnelDataLogic(insightProps))
    const { isFunnelWithEnoughSteps, validationError, theme } = useValues(insightVizDataLogic(insightProps))
    const {
        isFunnels,
        isPaths,
        hasDetailedResultsTable,
        showLegend,
        hasFormula,
        funnelsFilter,
        supportsDisplay,
        samplingFactor,
        insightDataLoading,
        erroredQueryId,
        timedOutQueryId,
        vizSpecificOptions,
        query,
    } = useValues(insightVizDataLogic(insightProps))
    const { loadData } = useActions(insightVizDataLogic(insightProps))
    const { exportContext, queryId } = useValues(insightDataLogic(insightProps))

    // Empty states that completely replace the graph
    const BlockingEmptyState = (() => {
        if (insightDataLoading) {
            return (
                <InsightLoadingState
                    queryId={queryId}
                    key={queryId}
                    insightProps={insightProps}
                    renderEmptyStateAsSkeleton={context?.renderEmptyStateAsSkeleton}
                />
            )
        }

        if (validationError) {
            return <InsightValidationError query={query} detail={validationError} />
        }

        // Insight specific empty states - note order is important here
        if (activeView === InsightType.FUNNELS) {
            if (!isFunnelWithEnoughSteps) {
                return <FunnelSingleStepState actionable={!embedded && insightMode === ItemMode.Edit} />
            }
            if (!hasFunnelResults && !erroredQueryId && !insightDataLoading) {
                return <InsightEmptyState heading={context?.emptyStateHeading} detail={context?.emptyStateDetail} />
            }
        }

        // Insight agnostic empty states
        if (erroredQueryId) {
            return (
                <InsightErrorState
                    query={query}
                    queryId={erroredQueryId}
                    onRetry={() => {
                        loadData(query && shouldQueryBeAsync(query) ? 'force_async' : 'force_blocking')
                    }}
                />
            )
        }
        if (timedOutQueryId) {
            return <InsightTimeoutState queryId={timedOutQueryId} />
        }

        return null
    })()

    function renderActiveView(): JSX.Element | null {
        switch (activeView) {
            case InsightType.TRENDS:
                return (
                    <TrendInsight
                        view={InsightType.TRENDS}
                        context={context}
                        embedded={embedded}
                        inSharedMode={inSharedMode}
                    />
                )
            case InsightType.STICKINESS:
                return (
                    <TrendInsight
                        view={InsightType.STICKINESS}
                        context={context}
                        embedded={embedded}
                        inSharedMode={inSharedMode}
                    />
                )
            case InsightType.LIFECYCLE:
                return (
                    <TrendInsight
                        view={InsightType.LIFECYCLE}
                        context={context}
                        embedded={embedded}
                        inSharedMode={inSharedMode}
                    />
                )
            case InsightType.CALENDAR_HEATMAP:
                if (featureFlags[FEATURE_FLAGS.CALENDAR_HEATMAP_INSIGHT]) {
                    return <InsightCalendarHeatMapContainer context={context} />
                }
                return null
            case InsightType.FUNNELS:
                return <Funnel inCardView={embedded} inSharedMode={inSharedMode} showPersonsModal={!inSharedMode} />
            case InsightType.RETENTION:
                return (
                    <RetentionContainer
                        context={context}
                        vizSpecificOptions={vizSpecificOptions?.[InsightType.RETENTION]}
                        inCardView={embedded}
                        inSharedMode={inSharedMode}
                    />
                )
            case InsightType.PATHS:
                return isUsingPathsV2 ? <PathsV2 /> : <Paths />
            default:
                return null
        }
    }

    function renderTable(): JSX.Element | null {
        if (
            isFunnels &&
            erroredQueryId === null &&
            timedOutQueryId === null &&
            isFunnelWithEnoughSteps &&
            hasFunnelResults &&
            funnelsFilter?.funnelVizType === FunnelVizType.Steps &&
            !disableTable
        ) {
            return (
                <>
                    <h2 className="font-semibold text-lg my-4 mx-0">Detailed results</h2>
                    <FunnelStepsTable />
                </>
            )
        }

        if (hasDetailedResultsTable && !disableTable) {
            return (
                <>
                    {exportContext && (
                        <div className="flex items-center justify-between my-4 mx-0">
                            <h2 className="font-semibold text-lg m-0">Detailed results</h2>
                            <Tooltip title="Export this table" placement="left">
                                <ExportButton
                                    type="secondary"
                                    items={[
                                        {
                                            export_format: ExporterFormat.CSV,
                                            export_context: exportContext,
                                        },
                                        {
                                            export_format: ExporterFormat.XLSX,
                                            export_context: exportContext,
                                        },
                                    ]}
                                />
                            </Tooltip>
                        </div>
                    )}

                    <InsightsTable
                        isLegend
                        filterKey={keyForInsightLogicProps('new')(insightProps)}
                        canEditSeriesNameInline={!hasFormula && insightMode === ItemMode.Edit}
                        seriesNameTooltip={
                            hasFormula && insightMode === ItemMode.Edit
                                ? 'Formula series names are not editable'
                                : undefined
                        }
                        canCheckUncheckSeries={canEditInsight}
                    />
                </>
            )
        }

        return null
    }

    const showComputationMetadata = !disableLastComputation || !!samplingFactor

    if (!theme) {
        return null
    }

    return (
        <>
            {/* These are filters that are reused between insight features. They each have generic logic that updates the url */}
            <div
                className={clsx(
                    `InsightVizDisplay InsightVizDisplay--type-${activeView.toLowerCase()}`,
                    !embedded && 'border rounded bg-surface-primary'
                )}
                data-attr="insights-graph"
            >
                {disableHeader ? null : <InsightDisplayConfig />}
                {showingResults && (
                    <>
                        {!embedded && (isFunnels || isPaths || showComputationMetadata) && (
                            <div className="flex items-center justify-between gap-2 p-2 flex-wrap-reverse border-b">
                                <div className="flex items-center gap-2">
                                    {showComputationMetadata && (
                                        <InsightResultMetadata
                                            disableLastComputation={disableLastComputation}
                                            disableLastComputationRefresh={disableLastComputationRefresh}
                                        />
                                    )}
                                </div>

                                <div className="flex items-center gap-2">
                                    {isPaths && isUsingPathsV1 && <PathCanvasLabel />}
                                    {isFunnels && <FunnelCanvasLabel />}
                                </div>
                            </div>
                        )}

                        <div
                            className={clsx(
                                'InsightVizDisplay__content',
                                supportsDisplay && showLegend && 'InsightVizDisplay__content--with-legend'
                            )}
                        >
                            {BlockingEmptyState ? (
                                BlockingEmptyState
                            ) : supportsDisplay && showLegend ? (
                                <>
                                    <div className="InsightVizDisplay__content__left">{renderActiveView()}</div>
                                    <div className="InsightVizDisplay__content__right">
                                        <InsightLegend />
                                    </div>
                                </>
                            ) : (
                                <>{renderActiveView()}</>
                            )}
                        </div>
                    </>
                )}
            </div>
            <ResultCustomizationsModal />
            {renderTable()}
            {!disableCorrelationTable && activeView === InsightType.FUNNELS && <FunnelCorrelation />}
        </>
    )
}
