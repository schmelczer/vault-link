const path = require("path");
const { merge } = require("webpack-merge");
const webpack = require("webpack");
const packageJson = require("./package.json");

const common = {
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
    plugins: [
        new webpack.DefinePlugin({
            __CURRENT_VERSION__: JSON.stringify(packageJson.version)
        })
    ],
    optimization: {
        // the consuming project should take care of minification
        minimize: false
    },
    resolve: {
        extensions: [".ts", ".js"],
        alias: {
            root: __dirname,
            src: path.resolve(__dirname, "src")
        }
    },
    performance: {
        hints: false // it's a library, no need to warn about its size
    }
};

module.exports = [
    merge(common, {
        target: "web",
        output: {
            path: path.resolve(__dirname, "dist"),
            filename: "sync-client.web.js",
            library: {
                name: "SyncClient",
                type: "umd"
            },
            globalObject: "this"
        }
    }),
    merge(common, {
        target: "node",
        output: {
            path: path.resolve(__dirname, "dist"),
            filename: "sync-client.node.js",
            libraryTarget: "commonjs2"
        }
    })
];
