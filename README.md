# Comprehensive Shopify Audit for GitHub Actions

Run Store Skills' paid Comprehensive Shopify Audit on GitHub-hosted Linux. The action reads the full active Check catalog from Glue's project MCP, runs Codex with an anonymous browser, and writes coverage counts to the job summary. Download the canonical `report.json` and `provenance.json` from the **comprehensive-shopify-audit** artifact. An incomplete or invalid report fails the run. Observed Issues are report results and do not fail the workflow.

## Set up the workflow

1. Sign in with a Store Skills Pro subscriber account and run `npx glue-fast@0.3.0 init-ci brickspacelab/storeskills --site https://glue.fast` in a private consumer repository. The repository's access controls protect paid Check content that can appear in the Codex workflow logs. Use a Store Skills release that declares the `comprehensive-shopify-audit` task.
2. Follow the generated CLI instructions to set `GLUE_INSTALL_TOKEN` and `GLUE_CUSTOMER_TOKEN` as GitHub Actions secrets. Add an `OPENAI_API_KEY` project API key for Codex usage. The GitHub-hosted runner uses your repository's Actions minutes and the key's OpenAI project pays for model usage.
3. Set the GitHub Actions repository variable `STORE_SKILLS_STOREFRONT_URL` to a publicly reachable HTTPS storefront or a deployed preview URL. In the generated workflow, add `storefront-url` under the action's existing `with` block, alongside `openai-api-key`.

   ```yaml
   storefront-url: ${{ vars.STORE_SKILLS_STOREFRONT_URL }}
   ```

4. Commit the generated workflow and its CLI helper. It runs for same-repository pull requests and can be dispatched manually after the workflow reaches the default branch. A pull request uses the configured storefront URL and the checked-out revision for source evidence. Set the URL to a deployed preview when you want to audit the PR's storefront changes.

The action needs read-only GitHub permissions. Browser evidence comes from anonymous navigation, viewport changes, accessibility snapshots, and console and request observations. Checks requiring cart or checkout actions, authenticated access, analytics, screenshots, or other missing evidence can record a Check-specific limitation. The runner keeps the job's Glue customer credential in the catalog-fetch step and uses the official Codex action's API proxy for model authentication.

To use a trusted OpenAI-compatible model provider, pass its Responses API URL as `responses-api-endpoint` and its model ID as `model`. Supply that provider's credential as `openai-api-key`. A protected Vercel Glue deployment can use `vercel-protection-bypass` for the catalog step. Its skill installation step also needs the deployment's protection header.

Run `npm ci --ignore-scripts` and `npm test` on Node 24 to verify the runner's catalog and report handling.
