# Jack-Core Agent Skill Stack

This directory is the governed, repository-local skill stack for the Torch/Jack engineering crew.

## Operating rule

Skills are capabilities, not authority. They never override `AGENTS.md`, the Jack Constitution, privacy/security policy, licensing boundaries, production gates, or the construction-site chain of command.

External skills are not blindly vendored. We adapt useful public patterns, record provenance/licensing before copying source verbatim, and fail closed when provenance is unclear.

## Installed stack

1. subagent-driven-development
2. worktree-isolation
3. verification-before-completion
4. systematic-debugging
5. root-cause-tracing
6. test-driven-development
7. branch-closeout
8. subagent-testing
9. code-review-response
10. review-evidence-pack
11. condition-based-waiting
12. multi-agent-patterns
13. context-degradation-detection
14. context-compression
15. durable-memory
16. agent-evaluation
17. tool-design
18. browser-runtime-testing
19. mcp-tool-builder
20. skill-workshop
21. surveyor (Torch custom)

Each skill is intentionally compact and implementation-neutral. FOREMAN/Superintendent should load the relevant skill for the task rather than dumping the whole stack into every worker context.
