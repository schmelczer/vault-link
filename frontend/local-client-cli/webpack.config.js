const path = require("path");
const webpack = require("webpack");

module.exports = {
    entry: {
        cli: "./src/cli.ts",
        healthcheck: "./src/healthcheck.ts"
    },
    target: "node",
    externals: { bufferutil: "bufferutil", "utf-8-validate": "utf-8-validate" },
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
    output: {
        globalObject: "this",
        filename: "[name].js",
        path: path.resolve(__dirname, "dist")
    },
    plugins: [
        new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true })
    ]
};
