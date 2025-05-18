# Nixpacks Integration for Zero-Downtime Deployer

This extension to the CloudLunacy deployment agent enables building Docker images using [Nixpacks](https://nixpacks.com/) instead of traditional Dockerfiles. Nixpacks automatically detects your application's language and dependencies to generate optimized Docker images.

## Benefits

- **No Dockerfile Required**: Nixpacks automatically detects your application's language and dependencies
- **Optimized Builds**: Creates efficient, multi-stage builds with proper caching
- **Simplified Maintenance**: Reduces the need to maintain template Dockerfiles for different app types
- **Consistency**: Provides reproducible builds across environments

## Usage

To enable Nixpacks for all deployments, set the following environment variable:

```
USE_NIXPACKS=true
```

You can also customize the location of Nixpacks configuration files:

```
NIXPACKS_CONFIG_DIR=/opt/cloudlunacy/nixpacks-configs
```

## Supported Languages and Frameworks

Nixpacks automatically detects the following:

- Node.js/JavaScript/TypeScript
- Python
- Go
- Rust
- Ruby
- PHP
- Java
- .NET
- And many more!

## Configuration

For advanced use cases, you can create custom Nixpacks configuration files in the `templates/nixpacks` directory. See the [Nixpacks documentation](https://nixpacks.com/docs/configuration) for details.

## Fallback Mechanism

The agent will fall back to using traditional Dockerfiles if:

1. `USE_NIXPACKS=false` (default)
2. Nixpacks installation fails
3. Nixpacks build fails

## Troubleshooting

If you encounter issues with Nixpacks builds, check the logs for detailed error messages. Common issues include:

- Missing system dependencies
- Unsupported language or framework
- Custom build requirements that Nixpacks can't auto-detect

For these cases, you may need to provide a custom [Nixpacks plan](https://nixpacks.com/docs/configuration/plans) or revert to traditional Dockerfiles.
