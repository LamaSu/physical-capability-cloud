# deployments/vnext: the V-next deploy records

`script/DeployVNextSettlement.s.sol` writes one record per deployment here:

- `<network>/CANONICAL.json` for the canonical deployment;
- `<network>/PROVISIONAL-<label>.json` for a provisional one, where `<label>` is `VNEXT_LABEL` (`[A-Za-z0-9_-]{1,64}`);
- a `DRYRUN-` prefix on either name for a run without `--broadcast`, so a simulation never writes the record itself.

Before a run broadcasts, the script reads the existing record back and refuses to publish a rival deployment under
the same name.

**This directory is committed on purpose, and must stay a real directory.** `foundry.toml` grants forge read-write
here and nowhere else in `deployments/`. The script refuses to read or write a record unless this directory exists,
no symlink sits at or above it, and no symlink sits anywhere below it. The grant alone does not contain a write
that goes through a symlink, and creating this directory at run time would follow a symlinked `deployments/`.
CI also fails on any committed symlink under `deployments/` (`ts/__tests__/deployments-no-symlinks.test.ts`).
