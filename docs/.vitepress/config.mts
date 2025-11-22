import { defineConfig } from "vitepress"

export default defineConfig({
	title: "VaultLink",
	description: "Self-hosted real-time synchronisation for Obsidian",
	base: "/vault-link/",
	themeConfig: {
		logo: "/logo.svg",
		nav: [
			{ text: "Home", link: "/" },
			{ text: "Guide", link: "/guide/getting-started" },
			{ text: "Architecture", link: "/architecture/" },
			{ text: "GitHub", link: "https://github.com/schmelczer/vault-link" }
		],
		sidebar: [
			{
				text: "Introduction",
				items: [
					{ text: "What is VaultLink?", link: "/guide/what-is-vaultlink" },
					{ text: "Getting Started", link: "/guide/getting-started" },
					{ text: "Comparison with Alternatives", link: "/guide/alternatives" }
				]
			},
			{
				text: "Setup",
				items: [
					{ text: "Server Setup", link: "/guide/server-setup" },
					{ text: "Obsidian Plugin", link: "/guide/obsidian-plugin" },
					{ text: "CLI Client", link: "/guide/cli-client" }
				]
			},
			{
				text: "Configuration",
				items: [
					{ text: "Server Configuration", link: "/config/server" },
					{ text: "Authentication", link: "/config/authentication" },
					{ text: "Advanced Options", link: "/config/advanced" }
				]
			},
			{
				text: "Architecture",
				items: [
					{ text: "Overview", link: "/architecture/" },
					{ text: "Sync Algorithm", link: "/architecture/sync-algorithm" },
					{ text: "Data Flow", link: "/architecture/data-flow" }
				]
			}
		],
		socialLinks: [{ icon: "github", link: "https://github.com/schmelczer/vault-link" }],
		footer: {
			message: "Released under the MIT License.",
			copyright: "Copyright © 2024-present Andras Schmelczer"
		},
		search: {
			provider: "local"
		}
	},
	head: [["link", { rel: "icon", type: "image/svg+xml", href: "/vault-link/logo.svg" }]]
})
