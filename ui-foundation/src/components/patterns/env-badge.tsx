import { Badge } from "@/components/ui/badge";

export type Environment = "production" | "staging" | "development";

const TONE = { production: "warning", staging: "info", development: "neutral" } as const;
const LABEL = { production: "Production", staging: "Staging", development: "Development" } as const;

/** Which environment the data is from. Production is never unlabeled. */
export function EnvBadge({ env }: { env: Environment }) {
  return (
    <Badge tone={TONE[env]} dot>
      {LABEL[env]}
    </Badge>
  );
}
