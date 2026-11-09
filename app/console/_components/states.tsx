import { Spinner } from "@/components/icons";
import { Button, Notice } from "@/components/ui";
import { ApiError } from "@/lib/client/api";

/** Trying again cannot fix a 404: the thing is not there. */
export const canRetry = (err: unknown) => !(err instanceof ApiError && err.status === 404);

/** Placeholder rows while a list loads. */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div aria-busy="true" className="space-y-3 rounded-xl border border-ink-200 bg-white p-5">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-ink-100" />)}
    </div>
  );
}

export function InlineLoading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-ink-500">
      <Spinner className="size-4 text-brand-500" /> {label}
    </p>
  );
}

/** A failed load: what went wrong, and a way to try again. */
export function LoadError({ message, onRetry, testId }: { message: string; onRetry?: () => void; testId: string }) {
  return (
    <div className="space-y-3">
      <Notice kind="error" testId={testId}>{message}</Notice>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>Try again</Button>
      )}
    </div>
  );
}
