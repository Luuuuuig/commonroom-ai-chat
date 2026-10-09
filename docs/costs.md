# Cost scenarios

Checked: 9 October 2026. These are published-price calculations, not a purchase or deployment. No hosting has been authorized or provisioned. Separately billed model APIs remain disabled.

## Existing subscriptions

The user's existing ChatGPT and Claude subscription fees continue independently. Their exact plans, prices, eligible clients, available usage, and account billing settings have not been verified. Do not count an API-credit allowance as subscription-limit usage, and do not enable paid overage or a model API fallback.

The prepared application uses mock providers. Its additional inference charge is zero because it sends no model requests. A future subscription client route may consume the same allowance as the user's other activity. An actual authenticated test must establish that billing route before real providers are enabled.

## One persistent Linux host

Engineering starting point: Ubuntu x64, at least 2 vCPU, 4 GB RAM, persistent disk, one sequential worker, SQLite, and HTTPS. Claude Code documents a minimum of 4 GB RAM and Ubuntu 20.04 or newer [H1]. An 8 GB host provides headroom for the app and clients; this is an engineering preference, not a provider requirement or a benchmark result.

| Host | RAM / disk | Compute | IPv4 | Provider backups | Total before VAT | Total with assumed 21% VAT |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Hetzner CX23, EU, 2 vCPU | 4 GB / 40 GB | €5.49 | €0.50 | €1.098 | €7.088 | €8.58 |
| Hetzner CX33, EU, 4 vCPU | 8 GB / 80 GB | €8.49 | €0.50 | €1.698 | €10.688 | €12.93 |
| Hetzner CPX22, EU, 2 vCPU | 4 GB / 80 GB | €19.49 | €0.50 | €3.898 | €23.888 | €28.90 |
| DigitalOcean Basic Regular, 2 vCPU, weekly backups | 4 GiB / 80 GiB | $24.00 | Included | $4.80 | $28.80 | $34.85 |
| DigitalOcean Basic Regular, 2 vCPU, daily backups | 4 GiB / 80 GiB | $24.00 | Included | $7.20 | $31.20 | $37.75 |

Hetzner calculation: `(server price × 1.20 + €0.50) × 1.21`, rounded only for the final estimate. Its documentation prices backups at 20% of the server price, with seven backup slots, and bills Primary IPv4 separately [H2–H4]. DigitalOcean calculation: `($24 × 1.20 or 1.30) × 1.21`. Its bundled plan includes a public IPv4; backup percentages are 20% weekly or 30% daily [D1–D3]. These backup products differ in retention and should not be treated as identical.

Public Hetzner pages returned “not available” for CX23/CX33 and several CPX plans. This is a public-page observation; authenticated inventory is unverified. Verify console stock and the final quote before purchase. Preferred low-cost target: CX33 if available. DigitalOcean is a more expensive candidate, not an automatically authorized fallback.

Tax assumption: a Netherlands private customer without a valid business VAT ID. Both providers list 21% Netherlands VAT [H5, D4]. Billing address, account status, rounding, and checkout determine the actual invoice. Prices remain in their original currencies; no USD/EUR conversion or card exchange fee is assumed.

Excluded: a new domain, independent off-provider backup storage, extra snapshots or volumes, transfer beyond the included allocation, and future price changes. TLS through the prepared Caddy configuration needs no purchased certificate. Use an existing approved hostname if available. No domain or storage purchase is included in this work.

Provider backups can contain application authentication material. They need restricted access. They do not replace an application-consistent SQLite backup and a tested restore.

## Cloud browser alternative, not selected

Browserbase Developer lists $20/month, 100 browser hours, then $0.12/hour; 1 GB proxy traffic, then $12/GB. Paid sessions last at most six hours. Its included allocations are not spending caps [B1]. These are browser infrastructure charges, separate from model subscriptions and the app host.

On-demand sessions within the included hours start at $20/month before tax. For illustration, two browsers kept running for a 30-day month use 1,440 hours: `$20 + (1,440 − 100) × $0.12 = $180.80`, before tax, proxy overage, and app hosting. Continuous browser sessions are unnecessary for many workflows and would need renewal after the session limit.

A local extension does not satisfy operation while the user's computer is off. Hosting a browser or extension on a VM adds maintenance and resource demand. Neither arrangement establishes permission to automate the native AI websites. Browserbase, website automation, and browser model gateways remain unconfigured.

## Approval boundary

Before spending, present the chosen provider, region, available instance, backup choice, final tax-inclusive quote, hostname arrangement, and any separate storage cost. Obtain hosting expenditure approval. Account sign-in and real-provider verification remain separate requirements. Never switch host size, provider, model billing method, or paid-overage setting silently.

## Primary sources

- [H1: Claude Code system requirements](https://code.claude.com/docs/en/setup)
- [H2: Hetzner current instance prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [H3: Hetzner Primary IP prices](https://docs.hetzner.com/cloud/servers/primary-ips/overview/)
- [H4: Hetzner backup and IP billing](https://docs.hetzner.com/cloud/billing/faq/)
- [H5: Hetzner VAT](https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/value-added-tax/)
- [H6: Hetzner cost-optimized specifications and public availability](https://www.hetzner.com/cloud/cost-optimized/)
- [H7: Hetzner regular-performance specifications](https://www.hetzner.com/cloud/regular-performance/)
- [D1: DigitalOcean Basic bundled prices](https://www.digitalocean.com/pricing/droplets)
- [D2: DigitalOcean bundled public IPv4 inclusion](https://www.digitalocean.com/products/droplets)
- [D3: DigitalOcean backup prices](https://docs.digitalocean.com/products/backups/details/pricing/)
- [D4: DigitalOcean EU tax](https://docs.digitalocean.com/platform/billing/taxes/eu/)
- [B1: Browserbase plans, allowances, overages, and session duration](https://docs.browserbase.com/account/billing/plans)
