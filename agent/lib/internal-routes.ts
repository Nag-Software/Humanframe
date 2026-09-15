/**
 * Paths Humanframe calls itself on.
 *
 * Kept in a module of its own so the caller can name the route without
 * importing the channel that serves it — that channel reaches the workflow
 * runtime, which only exists inside eve's build.
 *
 * Mounted under the framework prefix on purpose: `withEve` rewrites exactly one
 * source into the eve application, everything under `/eve/v1/`, so a route
 * outside that prefix is not reachable in this deployment. The `internal/`
 * segment keeps it clear of the framework's own health, info and session
 * routes.
 */
export const INTERNAL_TIMER_PATH = "/eve/v1/internal/commitments/timer";
