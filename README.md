# dora-card

The four [DORA metrics](https://dora.dev/guides/dora-metrics-four-keys/) for any repository that deploys with GitHub Actions, as a card for its README. No dependencies, no service to run: a GitHub Action reads your deploy workflow's history and writes an SVG.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zhenxi0901/dora-card/output/dora-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/zhenxi0901/dora-card/output/dora-light.svg" />
  <img alt="DORA metrics for zhenxi0901/portfolio over the last 30 days" src="https://raw.githubusercontent.com/zhenxi0901/dora-card/output/dora-light.svg" />
</picture>

That card is my [portfolio](https://github.com/zhenxi0901/portfolio)'s own deploy history, redrawn every six hours by this repository's [card workflow](.github/workflows/card.yml).

## Use it

Add a workflow that runs the action on a schedule and publishes the card to a branch of its own:

```yaml
name: dora-card
on:
  schedule: [{ cron: "0 */6 * * *" }]
  workflow_dispatch:
permissions: {}
jobs:
  card:
    runs-on: ubuntu-latest
    permissions:
      contents: write # to push the card to the output branch
      actions: read # to read the deploy workflow's runs
    steps:
      - uses: actions/checkout@v7
      - id: dora
        uses: zhenxi0901/dora-card@v1 # or pin a commit SHA
        with:
          workflow: deploy.yml
      - name: Publish the card to the output branch
        run: |
          git switch --orphan output
          mv dora/* . && rmdir dora
          git add dora-dark.svg dora-light.svg dora.json
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
            commit -q -m "DORA card: ${{ steps.dora.outputs.deploys }} deploys"
          git push -q --force origin output
```

Then show it in your README, in both themes:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/OWNER/REPO/output/dora-dark.svg" />
  <img alt="DORA metrics" src="https://raw.githubusercontent.com/OWNER/REPO/output/dora-light.svg" />
</picture>
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `workflow` | (required) | The deploy workflow's file name, such as `deploy.yml`. |
| `repository` | this repository | The repository to measure, as `owner/name`. |
| `branch` | `main` | Only runs on this branch count. |
| `job` | the whole run | Judge a run by this job alone, for a workflow that also tests, releases or cleans up. |
| `event` | any | Only runs started by this event, such as `push` or `workflow_run`: leaves out manual runs and drills. |
| `window-days` | `30` | How far back to measure, 1 to 365 days. |
| `title` | the repository | The card's title. |
| `output-dir` | `dora` | Where `dora.json`, `dora-dark.svg` and `dora-light.svg` go. |
| `token` | `github.token` | Reads the runs and commits. For another private repository, a token with `actions: read` and `contents: read` there. |

Outputs: `deploys`, `deploys-per-week`, `lead-time-hours`, `change-failure-rate` and `time-to-restore-hours`, and the same numbers in the job summary.

## What it measures

- **Deployment frequency:** successful deploy runs in the window, per week.
- **Lead time for changes:** for every commit shipped in the window, the time from its commit to the end of the deploy that first shipped it; the median. Which commits a deploy shipped comes from comparing it with the deploy before it, so a redeploy ships nothing and a commit is never counted twice.
- **Change failure rate:** failed deploys over all deploys (successful and failed) in the window. A run that times out is a failure; a cancelled or skipped one did not deploy.
- **Time to restore:** for each failed deploy, the time until the next successful one finished; the median.

## What it does not know

- It treats a deploy run as a change. DORA's change failure rate counts changes that hurt production, including ones whose deploy succeeded and was later rolled back by hand; a workflow can't see those. If your pipeline rolls back on its own, a failed run is close to the real thing.
- Restore time is from the failed run to the next good one, not from when users were affected.
- Lead time uses commit time (the committer date), so a branch that sat unmerged for a week counts that week.
- A comparison returns at most 250 commits, so a single deploy of more than 250 commits counts the newest 250.
- Re-runs count by their latest attempt.

My portfolio's own pipeline computes richer versions of these (automatic rollbacks, drills, per-commit lead time in its changelog); this action is the part of that which works for any repository.

## How it works

`src/main.mjs` lists the deploy workflow's completed runs on the branch, newest first, back to the last success before the window. With `job` set it reads each run's jobs. It asks the compare API which commits each deploy added, then `src/dora.mjs` computes the metrics and `src/card.mjs` draws the cards. A 30-day window of a busy repository is a few dozen API calls, well inside `GITHUB_TOKEN`'s limits.

```sh
node --test   # the metrics, the card, the API client and the action end to end, against a fake API
```

## License

MIT
