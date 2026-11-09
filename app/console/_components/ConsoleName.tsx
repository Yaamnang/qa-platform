/** "Eclypse QA console", with the accent on the part that tells it apart from the platform. */
export function ConsoleName({ className = "" }: { className?: string }) {
  return (
    <span className={`whitespace-nowrap text-[15px] font-semibold tracking-tight text-ink-900 ${className}`}>
      Eclypse <span className="text-brand-600">QA console</span>
    </span>
  );
}
