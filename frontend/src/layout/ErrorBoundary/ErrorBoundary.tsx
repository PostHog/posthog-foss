import './ErrorBoundary.scss'

import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { supportLogic } from 'lib/components/Support/supportLogic'
import { LemonButton } from 'lib/lemon-ui/LemonButton'
import { PostHogErrorBoundary } from 'posthog-js/react'
import { teamLogic } from 'scenes/teamLogic'

interface ErrorBoundaryProps {
    children?: React.ReactNode
    exceptionProps?: Record<string, number | string | boolean | bigint | symbol | null | undefined>
    className?: string
}

export function ErrorBoundary({ children, exceptionProps = {}, className }: ErrorBoundaryProps): JSX.Element {
    const { currentTeamId } = useValues(teamLogic)
    const { openSupportForm } = useActions(supportLogic)

    const additionalProperties = { ...exceptionProps }

    if (currentTeamId !== undefined) {
        additionalProperties.team_id = currentTeamId
    }

    return (
        <PostHogErrorBoundary
            additionalProperties={additionalProperties}
            fallback={({ error: { stack, name, message } }: { error: Error }) => (
                <div className={clsx('ErrorBoundary', className)}>
                    <h2>An error has occurred</h2>
                    <pre>
                        <code>
                            {stack || (
                                <>
                                    {name}
                                    <br />
                                    {message}
                                </>
                            )}
                        </code>
                    </pre>
                    Please help us resolve the issue by sending a screenshot of this message.
                    <LemonButton
                        type="primary"
                        fullWidth
                        center
                        onClick={() => openSupportForm({ kind: 'bug', isEmailFormOpen: true })}
                        targetBlank
                        className="mt-2"
                    >
                        Email an engineer
                    </LemonButton>
                </div>
            )}
        >
            {children}
        </PostHogErrorBoundary>
    )
}

export function LightErrorBoundary({ children, exceptionProps = {}, className }: ErrorBoundaryProps): JSX.Element {
    const { currentTeamId } = useValues(teamLogic)
    const additionalProperties = { ...exceptionProps }
    if (currentTeamId !== undefined) {
        additionalProperties.team_id = currentTeamId
    }
    return (
        <PostHogErrorBoundary
            additionalProperties={additionalProperties}
            fallback={({ error: { stack, name, message } }: { error: Error }) => (
                <div className={clsx('text-danger', className)}>
                    {stack || (name || message ? `${name}: ${message}` : 'Error')}
                </div>
            )}
        >
            {children}
        </PostHogErrorBoundary>
    )
}
