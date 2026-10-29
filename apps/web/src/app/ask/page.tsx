import { AskView } from "@/components/ask-view";
import { currentHospital, shelf } from "@/lib/data";

export default async function AskPage() {
	const hospital = await currentHospital();
	const { hospitals, protocols } = await shelf(hospital);
	const name = hospitals.find((h) => h.id === hospital)?.name ?? hospital;
	return <AskView hospital={name} protocolCount={protocols.length} />;
}
