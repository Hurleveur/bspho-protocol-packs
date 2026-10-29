import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	// MuPDF ships WASM: load it from node_modules at runtime instead of bundling it.
	serverExternalPackages: ["mupdf"],
	transpilePackages: ["@bspho/protocol"],
	env: { NEXT_PUBLIC_BUILD_YEAR: String(new Date().getFullYear()) },
	turbopack: {
		rules: {
			"*.css": {
				loaders: ["@tailwindcss/turbopack"],
				as: "*.css",
			},
		},
	},
};

export default nextConfig;
