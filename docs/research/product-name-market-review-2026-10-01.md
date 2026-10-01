# Personal agent product name market review

Reviewed October 1, 2026 for a possible OpenPalm rebrand under fwdslsh. The
product is a single-install home for a personal AI agent with persistent
knowledge, recurring work, and familiar client access. It is not another
chatbot or an enterprise orchestration platform.

**Recommendation:** there is no strong, clearly differentiated winner in this
list. Homestead and Keep are the strongest metaphors, but already have close
software products. Hold is the best candidate for further testing, preferably
qualified as **fwdslsh Hold**, not an approved final name. Seat is a weaker
backup candidate. Ainga is not an empty namespace: an exact-name AI knowledge
platform already markets under that name.

The [rebranding implementation guide](../technical/rebranding-implementation-guide.md)
separately covers code, configuration, documentation, distribution and
existing-install continuity. This research does not implement a rename.

## Scope and limits

The review checked current public product sites, official documentation,
first-party GitHub repositories, an App Store product listing, and primary
dictionary evidence where language mattered. Searches combined each exact
candidate with AI, agent, hosting, software, memory, MCP and CLI terms. A
market-analysis agent independently examined the less obvious candidates.

Findings describe what existing products claim, not a validation of their
security, capabilities, adoption or commercial success. Search difficulty,
semantic fit and recommendations below are editorial judgments, not measured
search traffic or customer-preference results.

This is not trademark clearance, a complete inventory of worldwide businesses,
or a domain/package/handle availability check. A missing salient result does
not establish availability. Adding fwdslsh improves identification but does not
prove that a conflicting name is legally usable.

## Candidate comparison

| Name | Product fit judgment | Verified market evidence | Recommendation |
|---|---|---|---|
| Homestead | Excellent home, ownership and self-sufficiency metaphor; approachable, though longer | Exact [Homestead](https://github.com/rambleraptor/homestead) is a self-hosted personal-app platform with agent support. Its [installer](https://myhomestead.dev/guides/installation) provides a `homestead` executable | Avoid bare Homestead: very close audience, proposition and command-name overlap |
| Turf | Short; conveys ownership and a place to work, but can sound territorial | Exact [Turf](https://github.com/turfbuild) is infrastructure for AI agents with MCP and a `turf` CLI. [Turf.js](https://turfjs.org/) is another established developer namespace | Avoid: direct agent-infrastructure and executable collision |
| Origin | Positive and easy to say; suggests a starting point more than a continuing home | Exact [Origin](https://github.com/Origin-AI-IDE/origin) is an AI-first IDE with agentic tools and persistent sessions. [OriginAI](https://www.originai.co/) is another AI company | Avoid: relevant existing AI brands plus a very generic search term |
| Ainga | More distinctive spelling, but pronunciation and meaning need explanation | Exact [Ainga Company Brain](https://www.ainga.tech/) offers on-premise enterprise knowledge, memory and agent actions with approval | Avoid for this product: exact-name AI/knowledge overlap, despite different customer segment |
| Stronghold | Clear protection and persistence metaphor, but militaristic and security-heavy | [Stronghold Security AI](https://strongholdsecurity.ai/) markets AI-agent monitoring and prompt-injection defenses. Another [Stronghold](https://github.com/stronghold-hq/stronghold) is an AI-infrastructure security proxy | Avoid: directly overlaps the Guardian/security part of our product |
| Keep | Excellent double meaning: a protected residence and retaining knowledge | Exact [keep](https://github.com/generalbusiness-ai/keep) is agent memory with a `keep` command, MCP and coding-harness integrations | Avoid: unusually close memory, client and CLI overlap |
| Citadel | Communicates protection, but feels like enterprise security rather than a simple personal home | Exact [Citadel](https://github.com/SethGammon/Citadel) adds persistent memory, safety hooks and coordination around Claude Code and Codex | Avoid: direct harness/memory/operations overlap |
| Hold | Can mean a protected place or retained possession; also suggests pause, restriction or being on hold | No salient exact bare-Hold personal-agent host was established in this scan. Compound [Glyph Hold](https://glyphhold.com/) is self-hosted AI-agent memory/secrets with MCP; exact [HOLD](https://apps.apple.com/us/app/hold-a-memory-for-videos/id6788027010) is an AI-assisted video-memory app | Further research only, preferably fwdslsh Hold. Less direct host-name overlap, not a clean namespace |
| Seat | Easy to spell; gives an agent a place beside you, but sounds like licensing rather than a home | No salient exact bare-Seat personal-agent host was established. Adjacent [Control Seat](https://www.ycombinator.com/companies/control-seat) is an industrial AI platform; ordinary per-seat pricing creates search ambiguity | Backup only; category clarity and home/persistence fit are weak |
| Tower | Suggests oversight and scale more than a personal home | Exact [Tower](https://docs.tower.dev/docs/intro) runs agents and scheduled workloads. Another [Tower](https://tower-org.github.io/tower/en/guide/introduction.html) orchestrates coding-agent tasks; [Tower Git client](https://www.git-tower.com/) adds developer-tool overlap | Avoid: several directly relevant software brands |

The evidence is strongest where a first-party source documents both the name
and a concrete capability or executable. The recommendations are not based
only on unrelated companies sharing an English word.

## Ainga language check

[Collins](https://www.collinsdictionary.com/dictionary/english/ainga) lists
*ainga* as a Samoan extended multigenerational family, also called *aiga*;
it gives the pronunciation `/ˌɑːˈɪŋə/`. It does not establish a literal
meaning of an AI agent's home. [Te Aka](https://maoridictionary.co.nz/search?keywords=ainga)
separately defines Māori *āinga* as a driving force or thing driven.

Do not build a convenient home-related etymology by conflating languages,
spellings or macrons. A culturally derived name deserves native-speaker input.
For this decision, the existing Ainga AI product is already a substantive
collision regardless of etymology.

## Positioning and shortlist

Our judgment is that the name should identify the agent's durable home, not
the agent itself. It should work in a sentence such as “Install it, connect
your AI, and let your agent remember and work for you.” It should not promise
that malicious prompts cannot succeed or that all processing stays local:
provider choice and direct native access still matter.

From these candidates:

1. **fwdslsh Hold** is worth a short comprehension test. Ask people what it
   hosts, what continues between sessions, and whether “hold” sounds active
   or paused. Check confusion with Glyph Hold and other existing software.
2. **fwdslsh Seat** is a secondary test only if the colleague/workspace metaphor
   is attractive. It is less suited to the stated “home for my agent” vision.
3. **Homestead and Keep** are semantic favorites, not recommended market choices.
   Their collisions are closer than their attractive meanings make apparent.
4. Consider additional distinctive compounds or coined names rather than
   forcing a generic fortress word to win. No alternative invented here has
   been screened or cleared.

## Checks before committing to a name

- Test spelling, pronunciation and product comprehension with nontechnical
  users; this scan did not conduct interviews.
- Check the exact intended npm scope/package, executable conflicts, container
  owner/repository, GitHub organization/repository, domain and social handles.
  Do not equate an available package with a legally usable product name.
- Perform appropriate trademark clearance for the actual markets and related
  goods/services, including similar marks and common-law use. The
  [USPTO clearance overview](https://www.uspto.gov/trademarks/search/comprehensive-clearance-search-similar-trademarks)
  explains why an exact-name database lookup alone is insufficient.
- Settle whether this is a rebranded OpenPalm distribution or an independent
  product. Then use the implementation guide to define a single release and
  existing-data transition, without changing technical contracts unnecessarily.

No name reservations, purchases, trademark filings or publishing changes were
made as part of this review.
