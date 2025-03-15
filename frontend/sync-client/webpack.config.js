const path = require("path");

module.exports = (_env, _argv) => ({
	entry: "./src/index.ts",
	module: {
		rules: [
			{
				test: /\.ts$/,
				use: ["ts-loader"]
			},
			{
				test: /\.wasm$/,
				type: "asset/inline"
			}
		]
	},
	optimization: {
		// the consuming project should take care of minification
		minimize: false
	},
	resolve: {
		extensions: [".ts"],
		alias: {
			root: __dirname,
			src: path.resolve(__dirname, "src")
		}
	},
	performance: {
		hints: false // it's a library, no need to warn about its size
	},
	output: {
		clean: true,
		filename: "index.js",
		globalObject: "this",
		library: {
			name: "SyncClient",
			type: "umd"
		},
		path: path.resolve(__dirname, "dist")
	}
});
