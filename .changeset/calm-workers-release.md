---
"eve": patch
---

Hooks can define a provider-neutral `lifecycle.release` handler. eve invokes it when root requests are released and when session trees complete, fail, or are cancelled, using each agent session's own hook registry and identity.
