import type { LocalRule } from "@bspho/protocol/spec";
import type { ProtocolEntry } from "@bspho/protocol/store";
import { formatVersion } from "@/lib/format";

/** Why a local rule needs a human look, or null when it is fine. */
export function concern(
	r: Pick<LocalRule, "state" | "attachedToSha256">,
	p: ProtocolEntry | undefined,
): string | null {
	if (r.state === "orphaned")
		return "The section this rule was attached to no longer exists in the protocol.";
	if (r.state === "reconfirm")
		return "The protocol text of this section changed in a new version.";
	if (p?.published && p.published !== r.attachedToSha256) {
		const was = p.versions.find((v) => v.sha256 === r.attachedToSha256);
		const now = p.versions.find((v) => v.sha256 === p.published);
		return `Written for ${formatVersion(was?.version)}, doctors now see ${formatVersion(now?.version)}. Check it still applies.`;
	}
	return null;
}
