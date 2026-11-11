/** A log line as the runner stores it: "HH:MM:SS text" (UTC). Lines from before times were added have none. */
const TIMED = /^(\d{2}:\d{2}:\d{2}) (.*)$/;

/**
 * The run's log, one row per line: the time in a fixed column, dimmed, then
 * the text. Used inside the log panels' scrolling <pre>.
 */
export function LogLines({ text }: { text: string }) {
  if (!text) return <span className="text-ink-500">No output yet.</span>;
  return text.split("\n").map((line, i) => {
    const m = TIMED.exec(line);
    return (
      <span key={i} className="flex gap-3">
        <span aria-hidden={m ? undefined : true} className="w-[4.5rem] shrink-0 select-none tabular-nums text-ink-400">{m?.[1] ?? ""}</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{m ? m[2] : line || " "}</span>
      </span>
    );
  });
}
