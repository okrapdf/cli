# @okrapdf/cli

Command-line interface for [OkraPDF](https://okrapdf.com) - extract tables from PDFs.

[![npm version](https://img.shields.io/npm/v/@okrapdf/cli.svg)](https://www.npmjs.com/package/@okrapdf/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
npm install -g @okrapdf/cli
```

Or use with npx:

```bash
npx @okrapdf/cli extract invoice.pdf
```

## Quick Start

```bash
# Set your API key
export OKRA_API_KEY=okra_xxxxxxxxxxxx

# Extract tables from a PDF
okra extract invoice.pdf -o json

# Ask a question about a document
okra run report.pdf "What is the total revenue?"
```

Get your API key from [okrapdf.com/settings/api-keys](https://okrapdf.com/settings/api-keys).

## Configuration

The CLI looks for your API key in this order:

1. `OKRA_API_KEY` environment variable
2. `.env` file in current directory
3. `.okra` file in current directory
4. `~/.okra` file in home directory
5. `~/.config/okrapdf/config.json`

Example `.env` or `.okra` file:

```bash
OKRA_API_KEY=okra_xxxxxxxxxxxx
OKRA_BASE_URL=https://okrapdf.com
```

## Commands

### Shortcuts (Most Common)

```bash
okra extract <file>          # Upload + extract + wait (all-in-one)
okra run <file> "question"   # Extract + ask question
```

### Documents

```bash
okra docs list               # List all documents
okra docs upload <file>      # Upload a PDF
okra docs get <uuid>         # Get document details
okra docs delete <uuid>      # Delete a document
```

### Jobs

```bash
okra jobs list               # List extraction jobs
okra jobs create <file>      # Create extraction job
okra jobs get <job-id>       # Get job status
okra jobs wait <job-id>      # Wait for completion
okra jobs results <job-id>   # Get extraction results
```

### Tables

```bash
okra tables list <doc-uuid>  # List extracted tables
okra tables get <table-id>   # Get table content
okra tables export <id>      # Export to CSV/JSON
```

### Interactive Chat

```bash
okra chat <document-uuid>    # Interactive document Q&A
```

## Output Formats

All commands support `-o, --output`:

- `table` (default) - Human-readable tables
- `json` - Machine-readable JSON
- `csv` - CSV format

```bash
# JSON for scripting
okra jobs list -o json | jq '.[].id'

# Quiet mode for piping
okra extract doc.pdf -o json -q > results.json
```

## For AI Agents

The CLI is designed to be agent-friendly:

```bash
# Get tables as JSON (for building presentations, reports)
okra extract document.pdf --json --quiet

# Get document list as JSON for processing
okra docs list -o json | jq '.[].uuid'

# Extract with specific processor
okra jobs create document.pdf -p gemini --wait -o json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OKRA_API_KEY` | API key (required) |
| `OKRA_BASE_URL` | Custom API URL (for self-hosted) |
| `OKRA_OUTPUT_FORMAT` | Default output format |

## Examples

### Batch Processing

```bash
for pdf in *.pdf; do
  okra extract "$pdf" -o json > "${pdf%.pdf}.json"
done
```

### CI/CD Integration

```bash
# Extract and check for tables
RESULT=$(okra extract report.pdf -o json -q)
TABLE_COUNT=$(echo "$RESULT" | jq '.tables | length')
echo "Found $TABLE_COUNT tables"
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Authentication error |
| 4 | Resource not found |
| 5 | Rate limited |

## Development

```bash
git clone https://github.com/okrapdf/cli
cd cli
npm install
npm run build
npm link
okra --help
```

## License

MIT - see [LICENSE](LICENSE)

## Links

- [OkraPDF](https://okrapdf.com)
- [Documentation](https://docs.okrapdf.com/cli)
- [API Reference](https://docs.okrapdf.com/api)
