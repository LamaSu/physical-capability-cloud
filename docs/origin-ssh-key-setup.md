# Fixing `origin` remote SSH key (item #2)

## Problem

`git push origin <branch>` returns `403 Permission denied to LamaSu`. The `origin` remote points to `global-mysterysnailrevolution/physical-capability-cloud`, but the locally configured credentials authenticate as the `LamaSu` account. Railway deploys from `lamasu/master`, so this is not a deploy blocker — but keeping both remotes pushable is cleaner git hygiene.

## Why this cannot be fully automated

Adding a key to a GitHub account requires a browser session with a 2FA challenge on that account. That interaction cannot be performed by a shell script. The automatable portion is key generation, ssh-agent setup, and remote URL rewrites.

## Steps (about 2 minutes)

### 1. Generate a dedicated key for the `global-mysterysnailrevolution` account
```bash
ssh-keygen -t ed25519 -C "globalmysterysnailrevolution+pcc@gmail.com" -f ~/.ssh/id_ed25519_gms -N ""
```

### 2. Add it to ssh-agent and print the public half
```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_gms
cat ~/.ssh/id_ed25519_gms.pub
```

### 3. Add the public key to the account (browser step)
- Log into https://github.com with the `global-mysterysnailrevolution` account
- Settings → SSH and GPG keys → New SSH key
- Title: `PCC dev laptop (2026-04)`
- Key type: `Authentication Key`
- Paste the contents of `id_ed25519_gms.pub`

### 4. Tell git which key to use for that host
Append to `~/.ssh/config`:
```
Host github.com-gms
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_gms
  IdentitiesOnly yes
```

### 5. Rewrite the `origin` URL to use the alias
```bash
cd ~/physical-capability-cloud
git remote set-url origin git@github.com-gms:global-mysterysnailrevolution/physical-capability-cloud.git
```

### 6. Verify
```bash
ssh -T git@github.com-gms                 # expects "Hi global-mysterysnailrevolution! You've successfully authenticated"
git fetch origin                          # should succeed
git push origin digital-verifier/foundation
```

## Alternatives worth considering

- **Fine-grained PAT on HTTPS**: Create a token scoped to the `global-mysterysnailrevolution/physical-capability-cloud` repo, then `git remote set-url origin https://globalmysterysnailrevolution:<token>@github.com/...`. Avoids SSH config entirely; PATs are revocable.
- **Drop the `origin` remote**: If Railway deploys from `lamasu/master` and `origin` serves no other purpose, `git remote remove origin` is the cheapest fix. The `global-mysterysnailrevolution` account is still documented as SUSPENDED or DEAD in memory — worth confirming before investing in key management.

## Recommendation

Drop `origin` unless there's a reason to keep it. Memory `pcc-detailed.md` flags that account as dead/suspended; maintaining push access to a dead account is negative leverage. Current push target `lamasu` is Railway's source of truth.

## Status

**Not executed in this pipeline** — the required GitHub UI step cannot be automated from the CLI. Handed to the user with the step-by-step above so it can be done in a minute if they still want both remotes pushable.
