const path = require("path");
const webpack = require("webpack");

const baseConfig = {
	target: "node",
	mode: "production",
	optimization: {
		minimize: false
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				use: "ts-loader"
			}
		]
	},
	resolve: {
		extensions: [".ts", ".js"]
	},
	plugins: [
		new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true })
	]
};

module.exports = [
	{
		...baseConfig,
		entry: "./src/cli.ts",
		output: {
			globalObject: "this",
			filename: "cli.js",
			path: path.resolve(__dirname, "dist")
		}
	},
	{
		...baseConfig,
		entry: "./src/deterministic/cli.ts",
		output: {
			globalObject: "this",
			filename: "deterministic/cli.js",
			path: path.resolve(__dirname, "dist")
		}
	}
];
