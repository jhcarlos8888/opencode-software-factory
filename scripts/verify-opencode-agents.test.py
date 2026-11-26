#!/usr/bin/env python3
"""Regression tests for the OpenCode agent registry verifier's path boundary."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("verify-opencode-agents.py")
SPEC = importlib.util.spec_from_file_location("verify_opencode_agents", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("No se pudo cargar verify-opencode-agents.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AgentPermissionContractTests(unittest.TestCase):
    def test_permission_frontmatter_parser_preserves_action_resource_effect(self):
        lines = [
            "description: Test agent",
            "mode: all",
            "permissions:",
            "  - action: edit",
            "    resource: \"*\"",
            "    effect: deny",
            "  - action: subagent",
            "    resource: tester",
            "    effect: allow"
        ]
        self.assertEqual(
            MODULE.parse_permission_rules(lines),
            [("edit", "*", "deny"), ("subagent", "tester", "allow")]
        )

    def test_permission_rules_use_last_matching_rule(self):
        rules = [
            ("edit", "*", "deny"),
            ("edit", "src/**", "allow"),
            ("shell", "*", "ask"),
            ("shell", "git push *", "deny")
        ]
        self.assertEqual(MODULE.effective_agent_permission(rules, "edit", "src/Main.java"), "allow")
        self.assertEqual(MODULE.effective_agent_permission(rules, "edit", "config/app.yml"), "deny")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "git push origin main"), "deny")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn test"), "ask")

    def test_shell_rule_with_trailing_space_wildcard_matches_bare_command(self):
        rules = [("shell", "mvn -B test *", "allow")]
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn -B test"), "allow")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn -B test -q"), "allow")

    def test_build_is_read_only_and_can_delegate_only_to_named_specialists(self):
        lines = [
            "permissions:",
            "  - action: edit", "    resource: \"*\"", "    effect: deny",
            "  - action: shell", "    resource: \"*\"", "    effect: deny",
            "  - action: subagent", "    resource: architect", "    effect: allow",
            "  - action: subagent", "    resource: implementer", "    effect: allow",
            "  - action: subagent", "    resource: reviewer", "    effect: allow",
            "  - action: subagent", "    resource: tester", "    effect: allow",
            "  - action: subagent", "    resource: cloud-arbiter", "    effect: allow",
            "  - action: subagent", "    resource: reverse", "    effect: allow"
        ]
        missing = MODULE.required_agent_permission_rules("build") - set(MODULE.parse_permission_rules(lines))
        self.assertEqual(missing, set())

    def test_read_only_agents_have_hard_deny_for_edit_and_shell(self):
        required = {("edit", "*", "deny"), ("shell", "*", "deny")}
        for agent in ("architect", "cloud-arbiter", "reviewer", "reverse"):
            with self.subTest(agent=agent):
                self.assertTrue(required.issubset(MODULE.required_agent_permission_rules(agent)))

    def test_tester_cannot_edit_but_shell_requires_approval_by_default(self):
        self.assertEqual(
            MODULE.required_agent_permission_rules("tester"),
            {("edit", "*", "deny"), ("shell", "*", "ask")}
        )

    def test_implementer_retains_explicit_destructive_command_denials(self):
        rules = MODULE.required_agent_permission_rules("implementer")
        self.assertIn(("shell", "git push *", "deny"), rules)
        self.assertIn(("shell", "sudo *", "deny"), rules)
        self.assertIn(("shell", "rm -rf *", "deny"), rules)


class SymlinkBoundaryTests(unittest.TestCase):
    def test_regular_project_paths_are_not_misclassified_as_symlinks(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-") as temp:
            root = Path(temp)
            agent = root / ".opencode" / "agents" / "reviewer.md"
            agent.parent.mkdir(parents=True)
            agent.write_text("---\nmode: all\n---\n", encoding="utf-8")
            self.assertFalse(MODULE.has_symlink_component(root, agent))

    def test_symlinked_agent_file_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-link-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-") as outside:
            root = Path(temp)
            external = Path(outside) / "reviewer.md"
            external.write_text("external", encoding="utf-8")
            agent_dir = root / ".opencode" / "agents"
            agent_dir.mkdir(parents=True)
            (agent_dir / "reviewer.md").symlink_to(external)
            self.assertTrue(MODULE.has_symlink_component(root, agent_dir / "reviewer.md"))

    def test_symlinked_parent_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-parent-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-parent-") as outside:
            root = Path(temp)
            external_agents = Path(outside) / "agents"
            external_agents.mkdir()
            (external_agents / "reviewer.md").write_text("external", encoding="utf-8")
            (root / ".opencode").symlink_to(Path(outside), target_is_directory=True)
            self.assertTrue(MODULE.has_symlink_component(root, root / ".opencode" / "agents" / "reviewer.md"))

    def test_path_outside_project_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-root-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-") as outside:
            self.assertTrue(MODULE.has_symlink_component(Path(temp), Path(outside) / "reviewer.md"))


class FilesystemMcpContractTests(unittest.TestCase):
    """Bootstrap estático seguro + codemode=true (regresiones env-only y launcher directo)."""

    # Réplica mínima del bootstrap canónico: resuelve el entrypoint inyectado
    # o el relativo de fábrica y falla de forma visible si no existe.
    BOOTSTRAP = (
        'const p=require("node:path"),u=require("node:url");'
        'const e=p.resolve(process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT'
        '||".opencode/mcp/factory-filesystem.mjs");'
        "process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT=e;"
        'import(u.pathToFileURL(e).href).catch(function(err){process.exit(1);});'
    )

    @staticmethod
    def canonical_server() -> dict:
        return {
            "type": "local",
            "command": ["node", "-e", FilesystemMcpContractTests.BOOTSTRAP],
            "enabled": True,
            "codemode": True,
            "environment": {
                "FACTORY_FILESYSTEM_MCP_ENTRYPOINT":
                    "{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}"
            },
        }

    def test_canonical_bootstrap_with_codemode_true_is_accepted(self):
        self.assertIsNone(MODULE.filesystem_mcp_contract_error(self.canonical_server()))

    def test_repository_opencode_json_satisfies_the_contract(self):
        config_path = Path(__file__).resolve().parent.parent / "opencode.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        server = (config.get("mcp") or {}).get("servers", {}).get("factory_filesystem")
        self.assertIsNone(MODULE.filesystem_mcp_contract_error(server))

    def test_direct_relative_launcher_is_rejected(self):
        server = self.canonical_server()
        server["command"] = ["node", ".opencode/mcp/factory-filesystem.mjs"]
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn("bootstrap estático", error or "")

    def test_env_only_launcher_is_rejected(self):
        server = self.canonical_server()
        server["command"] = ["node", "{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}"]
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn("bootstrap estático", error or "")
        self.assertIn("env-only", error or "")

    def test_bootstrap_without_entrypoint_resolution_is_rejected(self):
        server = self.canonical_server()
        server["command"] = ["node", "-e", 'const p=require("node:path");console.log(p.sep);']
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn(MODULE.FACTORY_FILESYSTEM_ENV_KEY, error or "")

    def test_bootstrap_with_forbidden_code_is_rejected(self):
        server = self.canonical_server()
        server["command"] = [
            "node",
            "-e",
            FilesystemMcpContractTests.BOOTSTRAP + 'require("child_process").exec("id");',
        ]
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn("prohibido", error or "")

    def test_codemode_false_is_rejected(self):
        server = self.canonical_server()
        server["codemode"] = False
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn("codemode=true", error or "")

    def test_missing_codemode_is_rejected(self):
        server = self.canonical_server()
        del server["codemode"]
        self.assertIsNotNone(MODULE.filesystem_mcp_contract_error(server))

    def test_disabled_server_is_rejected(self):
        server = self.canonical_server()
        server["enabled"] = False
        error = MODULE.filesystem_mcp_contract_error(server)
        self.assertIsNotNone(error)
        self.assertIn("enabled=true", error or "")

    def test_missing_server_or_non_local_type_is_rejected(self):
        self.assertIsNotNone(MODULE.filesystem_mcp_contract_error(None))
        server = self.canonical_server()
        server["type"] = "remote"
        self.assertIsNotNone(MODULE.filesystem_mcp_contract_error(server))

    def test_dropping_the_environment_guard_is_rejected(self):
        server = self.canonical_server()
        server["environment"] = {}
        self.assertIsNotNone(MODULE.filesystem_mcp_contract_error(server))


class AgentToolNomenclatureTests(unittest.TestCase):
    """Regresión de contrato: nomenclatura de herramientas y frontmatter intactos."""

    ROOT = Path(__file__).resolve().parent.parent
    AGENTS = ROOT / ".opencode" / "agents"
    CANONICAL = (
        "factory_filesystem_list_files",
        "factory_filesystem_read_file",
        "factory_filesystem_search_text",
    )
    EXECUTE = (
        "tools.factory_filesystem.list_files",
        "tools.factory_filesystem.read_file",
        "tools.factory_filesystem.search_text",
    )

    @staticmethod
    def frontmatter(path: Path) -> dict:
        lines = path.read_text(encoding="utf-8").splitlines()
        assert lines and lines[0].strip() == "---", path
        closing = lines.index("---", 1)
        values = {}
        for line in lines[1:closing]:
            if not line or line[0].isspace() or line.startswith("-") or ":" not in line:
                continue
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip().strip("\"'")
        return values

    def test_every_factory_agent_documents_canonical_tools_and_execute_equivalence(self):
        for agent_id in sorted(MODULE.EXPECTED_MODES):
            path = self.AGENTS / f"{agent_id}.md"
            self.assertTrue(path.is_file(), f"falta {path}")
            text = path.read_text(encoding="utf-8")
            for token in self.CANONICAL + self.EXECUTE:
                self.assertIn(token, text, f"{agent_id}: falta {token}")
            # La redacción obsoleta (sin la equivalencia) ya no debe existir.
            self.assertNotIn(
                "usa exclusivamente factory_filesystem_list_files.",
                text,
                f"{agent_id}: nomenclatura obsoleta",
            )

    def test_modes_models_and_descriptions_match_team_contract(self):
        for agent_id, expected_mode in MODULE.EXPECTED_MODES.items():
            values = self.frontmatter(self.AGENTS / f"{agent_id}.md")
            self.assertEqual(values.get("mode"), expected_mode, agent_id)
            self.assertEqual(values.get("model"), MODULE.EXPECTED_AGENT_MODELS[agent_id], agent_id)
            self.assertTrue(values.get("description"), agent_id)


    def test_heterogeneous_team_and_legacy_provider_contracts(self):
        expected = {
            "build": "opencode-go/kimi-k3.1-pro",
            "architect": "opencode-go/deepseek-v4.1-flash",
            "cloud-arbiter": "opencode-go/kimi-k3.1-pro",
            "implementer": "opencode-go/glm-5.3-flash",
            "reverse": "opencode-go/deepseek-v4.1-flash",
            "reviewer": "opencode-go/deepseek-v4.1-flash",
            "tester": "opencode-go/glm-5.3-flash",
        }
        self.assertEqual(MODULE.EXPECTED_AGENT_MODELS, expected)
        self.assertEqual(set(expected), set(MODULE.EXPECTED_MODES))
        for agent_id, model in expected.items():
            self.assertEqual(MODULE.expected_agent_model("opencode-go/kimi-k3.1-pro", agent_id), model)
            self.assertEqual(MODULE.expected_agent_model("opencode-go/mimo-v2.6-flash", agent_id), "opencode-go/mimo-v2.6-flash")
            self.assertEqual(MODULE.expected_agent_model("openrouter/custom", agent_id), "openrouter/custom")


if __name__ == "__main__":
    unittest.main(verbosity=2)
