#!/usr/bin/env python3
"""
VS Code extension entry point for OpenHarness backend host.

Usage:
    python -m openharness_vscode_bridge [--model MODEL] [--max-turns N]
        [--api-format FORMAT] [--permission-mode MODE] [--profile PROFILE]

Launches the ReactBackendHost, communicating via OHJSON: protocol on stdin/stdout.
"""

import argparse
import asyncio
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenHarness VS Code Backend Bridge")
    parser.add_argument("--model", default=None, help="Model alias or name")
    parser.add_argument("--max-turns", type=int, default=None, help="Max agent turns")
    parser.add_argument("--api-format", default=None, help="API format (anthropic/openai/copilot)")
    parser.add_argument("--base-url", default=None, help="Custom API base URL")
    parser.add_argument("--permission-mode", default=None, help="Permission mode")
    parser.add_argument("--profile", default=None, help="Provider profile name")
    parser.add_argument("--cwd", default=None, help="Working directory")
    args = parser.parse_args()

    from openharness.ui.backend_host import run_backend_host

    return asyncio.run(
        run_backend_host(
            model=args.model,
            max_turns=args.max_turns,
            api_format=args.api_format,
            base_url=args.base_url,
            permission_mode=args.permission_mode,
            active_profile=args.profile,
            cwd=args.cwd,
            enforce_max_turns=args.max_turns is not None,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
