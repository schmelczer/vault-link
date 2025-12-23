# VaultLink Documentation

This directory contains the VaultLink documentation site built with [VitePress](https://vitepress.dev/).

## Development

### Setup

```bash
cd docs
npm install
```

### Local Development

Start the development server with hot reload:

```bash
npm run dev
```

The site will be available at `http://localhost:5173/vault-link/`

### Build

Build the static site:

```bash
npm run build
```

Output will be in `.vitepress/dist/`

### Preview

Preview the built site:

```bash
npm run preview
```

### Format

Format all markdown and TypeScript files:

```bash
npm run format
```

Check formatting without making changes:

```bash
npm run format:check
```

### Spell Check

Check spelling (British English):

```bash
npm run spell
```

The spell checker enforces British English spellings (e.g., "synchronisation", "optimise", "behaviour").

## Deployment

The documentation is automatically deployed to GitHub Pages when changes are pushed to the `main` branch.

The deployment workflow is configured in `.github/workflows/deploy-docs.yml`.

## Structure

```
docs/
├── .vitepress/
│   └── config.ts          # VitePress configuration
├── public/                # Static assets
│   └── logo.svg          # VaultLink logo
├── guide/                # User guides
│   ├── what-is-vaultlink.md
│   ├── getting-started.md
│   ├── server-setup.md
│   ├── obsidian-plugin.md
│   └── cli-client.md
├── architecture/         # Architecture documentation
│   ├── index.md
│   ├── sync-algorithm.md
│   └── data-flow.md
├── config/              # Configuration reference
│   ├── server.md
│   ├── authentication.md
│   └── advanced.md
└── index.md            # Home page

```

## Writing Documentation

### Language

All documentation uses **British English**. The spell checker enforces this in CI.

### Markdown Features

VitePress supports:

- GitHub Flavoured Markdown
- Custom containers (tip, warning, danger)
- Code syntax highlighting
- Mermaid diagrams
- Emoji :rocket:

### Custom Containers

```markdown
::: tip
This is a tip
:::

::: warning
This is a warning
:::

::: danger
This is a danger message
:::
```

### Code Blocks

````markdown
```bash
npm install
```

```yaml
server:
    port: 3000
```
````

## Contributing

When adding new pages:

1. Create the markdown file in the appropriate directory
2. Add it to the sidebar in `.vitepress/config.ts`
3. Test locally with `npm run dev`
4. Submit a pull request

## License

MIT - Same as VaultLink
