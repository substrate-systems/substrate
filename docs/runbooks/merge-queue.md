# Merging into main

Main uses GitHub's merge queue. Before a pull request lands, the queue runs the
required checks (`test` and `onboarding end-to-end`) on main plus the queued
pull requests. Two pull requests that each pass alone can still break main
together, for example when both add a migration with the same number. The queue
catches that before either lands.

1. Wait until the review approves the pull request's current head.
2. Run `gh pr merge <number> --squash --match-head-commit <head SHA>`. The pull request joins the queue.
3. Wait for the queue. If the checks pass, GitHub merges the pull request.
4. If the queue removes the pull request, read the failed run, fix the cause, push, and repeat from step 1.

The expected result is a merged pull request whose merged tree passed the required checks.

Undo: remove the merge queue rule from main's ruleset in the repository settings.
