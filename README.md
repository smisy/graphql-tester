# graphql-tester

Lightweight CLI for sending GraphQL queries/mutations with custom headers — built for testing `X-Route-Override` against prod/test endpoints.

## Install

```bash
git clone https://github.com/smisy/graphql-tester.git
cd graphql-tester
npm install
```

Optionally link globally:
```bash
npm link  # now available as `gql` anywhere
```

## Setup

```bash
cp .env.example .env
# Edit .env with your endpoint and token
```

## Usage

### Basic query (uses .env defaults)
```bash
node index.js -q '{ allSalons { _id name } }'
```

### From a .graphql file
```bash
node index.js -f queries/all-salons.graphql
```

### With variables
```bash
node index.js -f queries/appointments.graphql \
  -v '{"salonId":"abc123","startDate":"2026-03-01","endDate":"2026-03-28"}'
```

### Route override (Go vs C#)
```bash
# Route to Go service
node index.js -f queries/all-salons.graphql --route go

# Route to C# management service
node index.js -f queries/all-salons.graphql --route csharp
```

### Compare Go vs C# responses (built-in)
```bash
# Single command: sends both, prints both, diffs automatically
node index.js -q '{ allSalons { _id name } }' --compare

# With --raw: also writes go.json and csharp.json for external tools
node index.js -f queries/all-salons.graphql --compare --raw
```

### Manual compare (if you prefer external diff)
```bash
node index.js -f queries/all-salons.graphql --route go --raw > go.json
node index.js -f queries/all-salons.graphql --route csharp --raw > csharp.json
diff <(jq -S . go.json) <(jq -S . csharp.json)
```

### Custom headers
```bash
node index.js -q '{ me { _id } }' -H "X-Custom:value" -H "X-Debug:true"
```

### Override URL and token inline
```bash
node index.js -u https://api.smisy.io/graphql -t "eyJ..." -q '{ me { _id } }'
```

### Pipe query from stdin
```bash
echo '{ allSalons { _id name } }' | node index.js
```

## Options

| Flag | Description | Env fallback |
|------|-------------|-------------|
| `-u, --url` | GraphQL endpoint | `GQL_URL` |
| `-t, --token` | Bearer token | `GQL_TOKEN` |
| `-q, --query` | Inline query string | — |
| `-f, --file` | Path to .graphql file | — |
| `-v, --variables` | JSON variables | `{}` |
| `-H, --header` | Custom header (repeatable) | — |
| `--route` | Shorthand for `X-Route-Override` | — |
| `--compare` | Send to both Go & C# routes, diff results | — |
| `--raw` | Raw JSON output (no formatting) | — |
| `--timing` | Show request duration | — |

## Output

- Request info → `stderr` (so you can pipe `stdout` cleanly)
- Response JSON → `stdout`
- Exit code `0` = success, `1` = request error, `2` = GraphQL errors

## License

MIT
