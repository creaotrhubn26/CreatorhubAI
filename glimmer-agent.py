#!/usr/bin/env python3

import argparse
import json
import os
import sys
from pathlib import Path
from urllib import error, request

API_BASE = os.environ.get("GLIMMER_URL", "http://127.0.0.1:8080")
API_KEY_FILE = Path.home() / "AI/muse-glimmer/config/api-key.txt"
DEFAULT_WORKSPACE = Path("/Users/danielqazi/Creatorhubn-monorepo")
MAX_TOOL_RESULT = 24000

READ_PATH_TOOLS = {
    "read_file",
    "file_glob_search",
    "grep_search",
}


def api_key():
    return API_KEY_FILE.read_text().strip()


def http_json(method, endpoint, payload=None, extra_headers=None):
    headers = {
        "Authorization": f"Bearer {api_key()}",
        "Content-Type": "application/json",
    }

    if extra_headers:
        headers.update(extra_headers)

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = request.Request(
        f"{API_BASE}{endpoint}",
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with request.urlopen(req, timeout=3600) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"HTTP {exc.code} {endpoint}\n{body}"
        ) from exc


def inside_workspace(path_value, workspace):
    path = Path(path_value).expanduser()

    if not path.is_absolute():
        path = workspace / path

    resolved = path.resolve(strict=False)

    try:
        resolved.relative_to(workspace)
    except ValueError:
        return None

    return resolved


def secure_tool_args(tool_name, args, workspace):
    if tool_name in READ_PATH_TOOLS:
        path_value = args.get("path", ".")

        resolved = inside_workspace(path_value, workspace)

        if resolved is None:
            raise PermissionError(
                f"Blocked path outside workspace: {path_value}"
            )

        args = dict(args)
        args["path"] = str(resolved)

    return args


def get_tools():
    raw_tools = http_json("GET", "/tools")

    definitions = []

    for item in raw_tools:
        definition = item.get("definition")
        if definition:
            definitions.append(definition)

    return definitions


def execute_tool(tool_name, arguments, workspace):
    arguments = secure_tool_args(tool_name, arguments, workspace)

    print(f"\n→ TOOL: {tool_name}")
    print(
        json.dumps(
            arguments,
            indent=2,
            ensure_ascii=False,
        )
    )

    result = http_json(
        "POST",
        "/tools",
        {
            "tool": tool_name,
            "params": arguments,
        },
        {
            "x-tool-cwd": str(workspace),
        },
    )

    if "plain_text_response" in result:
        content = str(result["plain_text_response"])
    else:
        content = json.dumps(
            result,
            ensure_ascii=False,
            indent=2,
        )

    if len(content) > MAX_TOOL_RESULT:
        content = (
            content[:MAX_TOOL_RESULT]
            + "\n\n[Tool result truncated by glimmer-agent]"
        )

    preview = content[:1200]

    print("← RESULT:")
    print(preview)

    if len(content) > len(preview):
        print("...")

    return content


def parse_arguments(raw):
    if isinstance(raw, dict):
        return raw

    if not raw:
        return {}

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(
            f"Model returned invalid tool arguments: {raw}"
        )



def chat_request_with_retry(payload, attempts=3):
    """
    Retry transient llama.cpp PEG tool-call parser failures.
    """
    last_error = None

    safe_payload = dict(payload)

    if "tools" in safe_payload:
        safe_payload["parallel_tool_calls"] = False

    for attempt in range(1, attempts + 1):
        try:
            return http_json(
                "POST",
                "/v1/chat/completions",
                safe_payload,
            )

        except RuntimeError as exc:
            message = str(exc)

            if "peg-native" not in message:
                raise

            last_error = exc

            print(
                f"\n⚠ PEG tool-call parser failure "
                f"(attempt {attempt}/{attempts})"
            )

            if attempt < attempts:
                print("Retrying the same agent turn...")

    raise last_error


def final_synthesis(messages):
    """
    Produce an answer without exposing tools to the model.
    Used as a fallback if native tool parsing repeatedly fails.
    """

    synthesis_messages = list(messages)

    synthesis_messages.append(
        {
            "role": "system",
            "content": (
                "Tool research must stop now. "
                "Using only the evidence already present in this conversation, "
                "produce the final answer. "
                "Do not request or invent additional tool calls. "
                "Clearly identify verified facts and cite exact repository paths."
            ),
        }
    )

    return http_json(
        "POST",
        "/v1/chat/completions",
        {
            "model": "muse-glimmer",
            "messages": synthesis_messages,
            "max_tokens": 4096,
        },
    )

def run_agent(prompt, workspace, max_turns):
    workspace = workspace.expanduser().resolve()

    if not workspace.is_dir():
        raise RuntimeError(
            f"Workspace does not exist: {workspace}"
        )

    tools = get_tools()

    if not tools:
        raise RuntimeError(
            "Server returned no tools. Is start-glimmer-agent.sh running?"
        )

    print(f"Workspace: {workspace}")
    print(f"Tools:     {len(tools)}")
    print("Model:     muse-glimmer")
    print()

    messages = [
        {
            "role": "system",
            "content": (
                "Reasoning strength: high. "
                "You are a software engineering agent working inside a repository. "
                "Use the provided repository tools to inspect actual files before "
                "making claims. Never invent files, dependencies, architecture, "
                "configuration, or test results. Use relative repository paths "
                "when possible. Gather enough evidence before answering. "
                "In your final answer cite the exact repository paths you inspected. "
                "Do not repeat the same tool call or re-read the same file unless "
                "you need a different line range or there is a specific unresolved question."
            ),
        },
        {
            "role": "user",
            "content": prompt,
        },
    ]

    for turn in range(max_turns):
        payload = {
            "model": "muse-glimmer",
            "messages": messages,
            "tools": tools,
            "tool_choice": "required" if turn == 0 else "auto",
            "parallel_tool_calls": False,
            "max_tokens": 4096,
        }

        # Reserve the final turn for synthesis.
        # On the last turn the model receives no tools and must answer
        # from evidence already gathered.
        if turn == max_turns - 1:
            payload.pop("tools", None)
            payload.pop("tool_choice", None)
            payload.pop("parallel_tool_calls", None)

            messages.append({
                "role": "system",
                "content": (
                    "Research is now complete. Do not request any more tools. "
                    "Produce the final answer using only evidence already gathered. "
                    "Clearly distinguish verified facts from anything uncertain, "
                    "and cite the exact repository paths inspected."
                ),
            })

        try:
            response = chat_request_with_retry(payload, attempts=3)

        except RuntimeError as exc:
            if "peg-native" not in str(exc):
                raise

            print(
                "\n⚠ PEG parser failed repeatedly. "
                "Switching to evidence-only final synthesis."
            )

            response = final_synthesis(messages)

        choice = response["choices"][0]
        message = choice["message"]

        tool_calls = message.get("tool_calls") or []

        if not tool_calls:
            print("\n════════════════════════════════════")
            print("GLIMMER")
            print("════════════════════════════════════\n")
            print(message.get("content") or "")
            return

        assistant_message = {
            "role": "assistant",
            "content": message.get("content"),
            "tool_calls": tool_calls,
        }

        messages.append(assistant_message)

        for index, tool_call in enumerate(tool_calls):
            if not tool_call.get("id"):
                tool_call["id"] = f"call_{turn}_{index}"
                assistant_message["tool_calls"][index]["id"] = tool_call["id"]

            function = tool_call.get("function", {})
            tool_name = function.get("name")

            try:
                arguments = parse_arguments(
                    function.get("arguments")
                )

                content = execute_tool(
                    tool_name,
                    arguments,
                    workspace,
                )

            except Exception as exc:
                content = f"Tool execution error: {exc}"
                print(f"\n✗ {content}")

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": content,
                }
            )

    raise RuntimeError(
        f"Agent reached max turn limit ({max_turns}) without a final answer."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Local Muse Glimmer repository agent"
    )

    parser.add_argument(
        "prompt",
        nargs="+",
        help="Task for Muse Glimmer",
    )

    parser.add_argument(
        "--workspace",
        type=Path,
        default=DEFAULT_WORKSPACE,
    )

    parser.add_argument(
        "--max-turns",
        type=int,
        default=24,
    )

    args = parser.parse_args()

    run_agent(
        " ".join(args.prompt),
        args.workspace,
        args.max_turns,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
