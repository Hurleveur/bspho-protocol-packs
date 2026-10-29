import { notFound } from "next/navigation";
import { Pack } from "@/components/pack";
import { ProtoLangProvider } from "@/components/proto-lang";
import { currentHospital, pack } from "@/lib/data";

export default async function ProtocolPage({ params }: PageProps<"/p/[id]">) {
	const { id } = await params;
	const data = await pack(id, await currentHospital());
	if (!data) notFound();
	return (
		<ProtoLangProvider>
			<Pack data={data} />
		</ProtoLangProvider>
	);
}
