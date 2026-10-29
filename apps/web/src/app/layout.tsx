import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./sheet.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
	title: "Protocol Packs · BSPHO",
	description: "Paediatric oncology trial protocols as fast, verified consult packs.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html
			lang="en"
			className={`${sans.variable} ${mono.variable} h-full antialiased`}
		>
			<body className="min-h-full">{children}</body>
		</html>
	);
}
