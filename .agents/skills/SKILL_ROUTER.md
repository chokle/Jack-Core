# Skill Router

Load only the skills relevant to the current task.

| Situation | Skills |
|---|---|
| Parallel implementation | subagent-driven-development, worktree-isolation, multi-agent-patterns |
| Bug/regression | systematic-debugging, root-cause-tracing, test-driven-development |
| Ready/done claim | verification-before-completion, review-evidence-pack, agent-evaluation |
| UI/runtime change | browser-runtime-testing, subagent-testing, verification-before-completion |
| Review findings | code-review-response, verification-before-completion |
| External dependency/wait | condition-based-waiting |
| Long-running agent | context-degradation-detection, context-compression, durable-memory |
| Missing/repeatedly painful capability | Surveyor, tool-design; mcp-tool-builder only if needed |
| Reusable solved procedure | skill-workshop |
| Branch completion | branch-closeout, review-evidence-pack |

Superintendent watches for systemic/tooling gaps and may invoke Surveyor. FOREMAN selects execution skills and dispatches workers. Dex/Lead Hand applies implementation skills. Inspector applies independent testing/evaluation. Daz owns final QC/QA evidence review within delegated authority.
