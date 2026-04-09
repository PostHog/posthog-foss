/**
 * Jest configuration and setup for Node.js integration tests
 *
 * This file:
 * - Configures PostgreSQL type parsers
 * - Mocks external HTTP dependencies (node-fetch, undici)
 * - Sets up logger spies for test assertions
 * - Provides mock HTTP responses for common endpoints
 * - Mocks process.exit to prevent test termination
 */

// eslint-disable-next-line no-restricted-imports
import fetch from 'node-fetch'
import { readFileSync } from 'fs'
import { DateTime } from 'luxon'
import { join } from 'path'

import { installPostgresTypeParsers } from './src/utils/db/postgres'
import { logger, shutdownLogger } from './src/utils/logger'

// Sets up the same type parsers as used everywhere else in the codebase
installPostgresTypeParsers()

// ============================================================================
// Mock Data Constants
// ============================================================================

/**
 * Mock response bodies for common test URLs
 * Maps URL patterns to their corresponding response data
 */
const MOCK_RESPONSES: Record<string, any> = {
    'https://google.com/results.json?query=fetched': {
        count: 2,
        query: 'bla',
        results: [true, true],
    },
    'https://mmdbcdn.posthog.net/': readFileSync(join(__dirname, 'tests', 'assets', 'GeoLite2-City-Test.mmdb.br')),
    'https://app.posthog.com/api/event?token=THIS+IS+NOT+A+TOKEN+FOR+TEAM+2': {
        hello: 'world',
    },
    'https://onevent.com/': {
        success: true,
    },
    'https://www.example.com': {
        example: 'data',
    },
}

/**
 * Mock response headers for specific URLs
 * Maps URL patterns to their corresponding header maps
 */
const MOCK_HEADERS: Record<string, Map<string, string>> = {
    'https://mmdbcdn.posthog.net/': new Map([
        ['content-type', 'vnd.maxmind.maxmind-db'],
        [
            'content-disposition',
            `attachment; filename="GeoLite2-City-${DateTime.local().toISODate()}.mmdb"`,
        ],
    ]),
}

// ============================================================================
// Mock Utilities
// ============================================================================

/**
 * Creates a mock Response-like object that matches the interface expected by recordedFetch
 * @param url - The URL being fetched
 * @param options - Fetch options (includes method, headers, etc.)
 * @returns A mock Response-like object
 */
function createMockResponse(url: string, options: Record<string, any> = {}): Record<string, any> {
    const responseBody = MOCK_RESPONSES[url] ?? { fetch: 'mock' }
    const responseHeaders = MOCK_HEADERS[url] ?? new Map<string, string>()
    const responseText =
        typeof responseBody === 'object' && !Buffer.isBuffer(responseBody)
            ? JSON.stringify(responseBody)
            : String(responseBody)

    // Create a proper Response-like object that matches the interface expected by recordedFetch
    return {
        // Properties
        status: options.method === 'PUT' ? 201 : 200,
        statusText: 'OK',
        ok: true,
        headers: {
            get: (name: string): string | null => {
                if (responseHeaders instanceof Map) {
                    return responseHeaders.get(name) ?? null
                }
                return null
            },
            forEach: (callback: (value: string, key: string) => void): void => {
                if (responseHeaders instanceof Map) {
                    responseHeaders.forEach((value, key) => callback(value, key))
                }
            },
        },

        // Methods
        buffer: (): Promise<Buffer> =>
            Promise.resolve(Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(responseText)),
        json: (): Promise<any> => Promise.resolve(responseBody),
        text: (): Promise<string> => Promise.resolve(responseText),

        // Clone method that returns a similar object with the same interface
        clone: function (): Record<string, any> {
            return createMockResponse(url, options)
        },
    }
}

/**
 * Setup logger spies for all test methods
 */
function setupLoggerSpies(): void {
    const logMethods = ['info', 'warn', 'debug', 'error'] as const

    logMethods.forEach((method) => {
        jest.spyOn(logger, method)
        jest.mocked(logger[method]).mockClear()
    })
}

// ============================================================================
// Module Mocks
// ============================================================================

/**
 * Mock @pyroscope/nodejs to avoid ESM compatibility issues with p-limit
 */
jest.mock('@pyroscope/nodejs', () => ({
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
}))

/**
 * Mock node-fetch default export while preserving other exports
 */
jest.mock('node-fetch', () => ({
    __esModule: true,
    ...jest.requireActual('node-fetch'), // Only mock fetch(), leave Request, Response, FetchError, etc. alone
    default: jest.fn(),
}))

/**
 * Mock undici fetch while preserving other exports
 */
jest.mock('undici', () => ({
    __esModule: true,
    ...jest.requireActual('undici'), // Only mock fetch(), leave Request, Response, FetchError, etc. alone
    fetch: jest.spyOn(jest.requireActual('undici'), 'fetch'),
}))

// ============================================================================
// Test Hooks
// ============================================================================

beforeEach(() => {
    setupLoggerSpies()

    jest.mocked(fetch as any).mockImplementation((url: string, options: Record<string, any> = {}) => {
        return Promise.resolve(createMockResponse(url, options))
    })
})

beforeAll(() => {
    // We use process.exit in a few places, which end up terminating tests
    // if we don't mock it.
    jest.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
    })
})

afterAll(async () => {
    // Shutdown logger to prevent Jest from hanging on open handles
    await shutdownLogger()
})
