# Nixpacks Integration for Zero-Downtime Deployer

This extension to the CloudLunacy deployment agent enables building Docker images using [Nixpacks](https://nixpacks.com/) instead of traditional Dockerfiles. Nixpacks automatically detects your application's language and dependencies to generate optimized Docker images.

## Benefits

- **No Dockerfile Required**: Nixpacks automatically detects your application's language and dependencies
- **Optimized Builds**: Creates efficient, multi-stage builds with proper caching
- **Simplified Maintenance**: Reduces the need to maintain template Dockerfiles for different app types
- **Consistency**: Provides reproducible builds across environments

## Installation Options

### Option 1: During Agent Installation (Recommended)

You can install Nixpacks automatically during the agent setup process by setting the environment variable:

```bash
INSTALL_NIXPACKS=true ./scripts/install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_BASE_URL]
```

This will attempt to install Nixpacks using the best available method (npm, curl, brew, or Docker-based wrapper) and configure your agent to use it automatically.

### Option 2: Dynamic Installation (Fallback)

If not pre-installed, the agent can dynamically install Nixpacks when needed during deployment. To enable dynamic installation, set:

```bash
USE_NIXPACKS=true
NIXPACKS_SKIP_AUTO_INSTALL=false
```

This approach may slow down your first deployment but provides resilience when the pre-installation fails.

### Option 3: Manual Installation

You can manually install Nixpacks using one of these methods:

```bash
# Using npm
npm install -g nixpacks

# Using curl
curl -sSL https://nixpacks.com/install.sh | bash

# Using Homebrew (macOS)
brew install nixpacks
```

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

## Installation Methods

The CloudLunacy agent will attempt to install Nixpacks automatically using multiple methods in the following order:

1. Using `npm install -g nixpacks` (if npm is available)
2. Using the official install script via `curl` (if curl is available)
3. Using Homebrew via `brew install nixpacks` (if brew is available)
4. Using Docker fallback mechanism (if Docker is available)

The Docker fallback creates a wrapper script that uses the official Nixpacks Docker image to provide the same functionality.

## Fallback Mechanism

The agent has a robust multi-level fallback system:

1. If `USE_NIXPACKS=false` (default), traditional Dockerfiles will be used
2. If Nixpacks installation fails across all methods, a Docker-based wrapper will be created
3. If the wrapper creation fails, a simple Dockerfile will be generated based on project type detection
4. If Docker build fails, detailed error messages will be provided

## Project Type Detection

When falling back to Docker builds, the agent automatically detects project types including:

- Node.js (Express, React, Next.js)
- Python
- Ruby
- And others

## Troubleshooting

If you encounter issues with Nixpacks builds, check the logs for detailed error messages. Common issues include:

- Missing system dependencies
- Unsupported language or framework
- Custom build requirements that Nixpacks can't auto-detect

For these cases, you may need to provide a custom [Nixpacks plan](https://nixpacks.com/docs/configuration/plans) or use the `FORCE_DOCKER_BUILD=true` environment variable to bypass Nixpacks entirely.
