# Vercel deployment policy

Git pushes deploy `main` automatically. Every other branch is opted out through
`git.deploymentEnabled` in `vercel.json`, including slash-containing task branches.
This prevents routine agent branches from creating unused preview builds.

Run tests and production builds locally with disposable test state. When a real
preview is needed, deploy the reviewed branch explicitly with the Vercel CLI
from a checkout linked to this project. Do not use `--prod` for a preview. Record
its purpose and remove that exact preview when its acceptance work is finished.

An old branch needs the current `vercel.json` before its next push; this policy
does not retroactively change its committed configuration. It also does not
delete existing deployments or reduce retained storage by itself. Inventory
old deployments separately, preserve production/current aliases and rollback
targets, and remove only confirmed unused previews.

Reference: [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).
