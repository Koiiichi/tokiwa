# Health

The Health view shows the state of the cloud host as plain text: the instance, an estimate of its spend, the limits of the workbench service, storage and network.
It does not change the host, its workloads or its service limits. The spend figures are an estimate at list prices, not billing data.

`h` opens the view and `w` returns to the sessions. For the drawing of sections, rows and bars, see [DESIGN.md](../DESIGN.md).

## Sections

| Section | Rows | Source |
| --- | --- | --- |
| Workstation | `Instance:` (the instance ID, type and region, and its state when it is not running), `Uptime:`, `Authorization:` (days left) and the end time | `tokiwa spend`, `tokiwa health`, `health.json` |
| Spend (estimate) | `Spent so far:` and, with a budget, a bar of it against the budget, `Forecast:`, `Month to date:`, and a note on what the estimate counts | `tokiwa spend`, `health.json` |
| Workbench limits | `CPU` of the CPU quota, `Memory` of the memory limit, `Tasks` of the task limit, each as a bar | `tokiwa health`: the cgroup of `cloud-workbench.service` |
| Storage | One bar for each disk that the host reports, used of total | `tokiwa health` |
| Network · INTERFACE | `Received:` and `Sent:`: the rate now and the total since boot | `tokiwa health`: the interface of the default IPv4 route |

The last line gives the time of the sample and its age, for example `Sampled 14:02:31 · 12s ago`. It adds the state when the state is not `live`. After a failed read, a second line says `Last read failed:` and the error.

Missing data shows as `not available` with the reason, never as zero:

| Reason | Cause |
| --- | --- |
| `no health reading yet` | No sample has arrived. |
| `host health script is older` | The sample has no `host` field. |
| `no AWS reading yet` | `tokiwa spend` has not answered. |
| `configuration is invalid` | `health.json` has an error. The Spend section shows the error line. |
| `the launcher has no spend command; install the updated launcher` | The launcher rejected `spend`. |

A bar and its figure turn amber at 80 % and soft orange at 95 %. The `Forecast:` row turns amber at 95 % of the budget and soft orange above the budget. The `Authorization:` row turns amber at 7 days left or fewer and soft orange below 1 day. A CPU, memory or task figure without a limit shows `(no quota)` or `(no limit)` and no bar.

The host side of `tokiwa health` is [`workbench-health.py`](../host/workbench-health.py). See [Host](host.md).

## Sampling

Sampling starts when the app starts and stops when the app closes. It runs in every view, not only while Health is in view.

| Rule | Value |
| --- | --- |
| Request | `tokiwa health`, through the launcher. One request runs at a time. |
| Interval | 30 seconds after the previous request ends. |
| Request time limit | 90 seconds. The launcher process then stops, and the read counts as failed. |
| History bound | The last 120 samples and the last 120 read events, in memory. |
| Attempts | No limit. A failed read does not stop sampling. |
| Spend reading | `tokiwa spend` after the first sample, then after a sample when the last spend read started 15 minutes ago or more. |
| Redraw | Every second while Health is in view, so the age stays current. |

The app rejects a sample that is not valid. A rejected sample counts as a failed read.

| Check | Error |
| --- | --- |
| The JSON has `sampled_at`, `metrics.cpu_percent` and `metrics.ram_percent` from 0 to 100, `rows` and `errors` | `The health response is invalid.` and similar |
| `sampled_at` is at most 5 seconds ahead of the Mac clock and at most 120 seconds behind it | `The backend sample timestamp is stale.` |
| `sampled_at` is later than the previous sample | `The sample timestamp did not advance.` |

A Health read also sets the link state in the header; see [Interface](interface.md#header).

## States

| State | Condition | Last line |
| --- | --- | --- |
| `live` | The last sample is at most 65 seconds old, and the last read reported no error. | `Sampled HH:MM:SS · Ns ago` |
| `stale` | The last sample is more than 65 seconds old. | `… · stale`, in amber |
| `partial` | At least one sample exists, and the last read failed or the host reported errors in its sample. | `… · partial` |
| `error` | The reads failed, and no sample exists. | `Waiting for the first health reading`, then `Last read failed:` |
| `recorded` | The reading comes from `--snapshot FILE`. | `… · recorded` |

Before the first read ends, the last line says `Waiting for the first health reading`. `recorded` takes precedence over the other states, and `partial` takes precedence over `stale`.

## Spend estimate

The estimate uses the list prices in `health.json` and the inventory that `tokiwa spend` reads: the instance type, its state and last start, its attached volumes and its public addresses.

| Figure | Calculation |
| --- | --- |
| Compute | Hours since the later of the start of the UTC month and the last start of the instance, times `prices.instance_hour` of its type. |
| Storage | The size of each volume times `prices.volume_gb_month` of its type, spread over 730 hours a month, from the start of the month. |
| Public IPv4 | The distinct public addresses of the instance and its Elastic IP addresses, times `prices.public_ipv4_hour`, from the start of the month. |
| `Month to date:` | Compute plus storage plus public IPv4. |
| `Spent so far:` | `prior_spend_usd` plus the month to date. With `budget_usd`, a bar shows it as a share of the budget. |
| `Forecast:` | Spent so far plus the cost from now to `authorization_end` (or to the end of the month without it), with the host running and the same volumes and addresses. It shows the date and its share of `budget_usd`. |

The estimate counts nothing else. It does not count data transfer, snapshots, provisioned IOPS or throughput, or tax. Spend before the current month counts only through `prior_spend_usd`.

The estimate is `not available` with the reason in these cases:

| Reason | Cause |
| --- | --- |
| `no price for TYPE in health.json` | No instance price for the instance type. |
| `no price for TYPE volumes in health.json` | No volume price for a volume type. |
| `the host is STATE; its running hours this month are unknown` | The instance is not running. |

## Recorded reading

`app/run --snapshot FILE` shows one recorded reading in place of live samples:

```sh
app/run --snapshot /absolute/path/to/reading.json
```

Give an absolute path, because `app/run` changes to its own folder first. FILE holds one JSON object in the form that `tokiwa health` prints. The app checks its form but not its age. The view shows that one sample with the state `recorded`. The app does not start the sampler, so it does not read `tokiwa spend`, and the Spend section shows `no AWS reading yet`. The session list still reads the host. A file that is missing or not valid stops the app at start with an error.

## health.json

`~/.config/tokiwa/health.json` holds the budget, the authorization end and the prices of one host. The app reads it once at start. Each key is optional. A missing file gives the defaults. A price map adds its entries to the default map.

A file that cannot be read, is not JSON, or has an unknown key or a wrong value gives the defaults and one error line in the Spend section, for example `~/.config/tokiwa/health.json: budget_usd must be a positive number`. The estimate and the `Authorization:` row then show `not available (configuration is invalid)`.

| Key | Default | Meaning |
| --- | --- | --- |
| `budget_usd` | None | Positive number. With it, a bar shows spend so far as a share of it, and the `Forecast:` row gives the forecast as a share of it. Without it, Spend shows amounts only. |
| `authorization_end` | None | ISO 8601 time with an offset. The forecast runs to this time, and the Host section shows the days left and the end time in that offset. Without it, the forecast runs to the end of the month (UTC) and Host shows no end row. |
| `prior_spend_usd` | `0` | Zero or more. Spend before the current month that counts against the budget. It is part of `Spent so far:` and of the forecast. |
| `prices.instance_hour` | `{}` | USD per hour for each instance type. Spend shows `no price for <type> in health.json` until the map holds the type of the instance. |
| `prices.volume_gb_month` | `{ "gp3": 0.08 }` | USD per GiB-month for each EBS volume type. A month is 730 hours. |
| `prices.public_ipv4_hour` | `0.005` | USD per hour for each public IPv4 address. |

`authorization_end` is separate from `end` in the host settings; see [Configuration](configuration.md#host-settings).

## Related

- [Interface](interface.md)
- [Configuration](configuration.md)
- [Host](host.md)
- [DESIGN.md](../DESIGN.md)
