import type { SpecDiff } from "@bspho/protocol/diff";
import type { HospitalStatus, Warning } from "@bspho/protocol/spec";
import type { Family } from "@bspho/protocol/store";

export type StageName =
	| "parse"
	| "identity"
	| "sections"
	| "label"
	| "anchors"
	| "check";

export type StageEvent = {
	stage: StageName | "done";
	message: string;
	ms?: number;
	counts?: Record<string, number>;
};

/** The `result` event of /internal/upload. */
export interface UploadResult {
	protocolId: string;
	short: string;
	title: string;
	family: Family;
	isNew: boolean;
	alreadyPublished: boolean;
	sha256: string;
	version: string;
	date: string | null;
	pageCount: number;
	supersedes: { version: string; sha256: string } | null;
	counts: {
		sections: number;
		steps: number;
		stepsWithStart: number;
		links: number;
		verifiedLinks: number;
	};
	warnings: Warning[];
	diff: (SpecDiff & { truncated: number }) | null;
}

export type ParticipationLite = {
	protocolId: string;
	hospital: string;
	participating: boolean;
	status: HospitalStatus;
};
