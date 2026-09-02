import { CandidateResult } from "@/lib/types";
import { Badge, Button } from "./ui";

export function CandidateRow({
  candidate,
  onAssign,
  assigning,
}: {
  candidate: CandidateResult;
  onAssign: () => void;
  assigning: boolean;
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
        disabled={assigning}
        className="self-start"
      >
        {assigning ? "Assigning…" : recommended ? "Assign" : "Assign with override"}
      </Button>
    </div>
  );
}
