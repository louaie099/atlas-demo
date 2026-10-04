import { CandidateResult } from "@/lib/types";
import { Badge, Button } from "./ui";

export function CandidateRow({
  candidate,
  onAssign,
  assigning,
  disabled = false,
  actionLabel,
}: {
  candidate: CandidateResult;
  onAssign: () => void;
  assigning: boolean;
  /** True when the current role may not act (e.g. Viewer) — the button
   * stays visible (so the candidate ranking is still informative) but
   * can't be clicked. */
  disabled?: boolean;
  /** Overrides the default "Assign"/"Assign with override" wording — used
   * by the Live Operations reassignment flow (find-agent-sheet.tsx) so
   * the button reads "Reassign" instead. */
  actionLabel?: string;
}) {
  const recommended = candidate.status === "recommended";

  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-2 ${
        recommended ? "border-good-500/40 bg-good-50/40" : "border-border bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-ink">{candidate.employee.name}</span>
        <Badge tone={recommended ? "good" : "warn"}>
          {recommended ? "Recommended" : "Flagged"}
        </Badge>
      </div>
      <p className="text-sm text-muted">{candidate.reasoning}</p>
      <Button
        variant={recommended ? "primary" : "secondary"}
        onClick={onAssign}
        disabled={assigning || disabled}
        className="self-start"
      >
        {assigning
          ? `${actionLabel ?? "Assign"}ing…`
          : actionLabel
          ? recommended
            ? actionLabel
            : `${actionLabel} with override`
          : recommended
          ? "Assign"
          : "Assign with override"}
      </Button>
    </div>
  );
}
