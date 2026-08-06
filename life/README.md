# Life Paths

The **Life Paths** item replaces the one-path-at-a-time calculation from
Inertia with a saved, mix-and-match planning workspace.

## What is kept together

One Life Paths item holds three reusable lists:

- **Income paths** — hourly work, an annual salary, or contractor work.
- **Goals** — each goal has a target amount and the amount already saved.
- **Life plans** — scenarios that select any combination of income paths and
  goals. For example, one plan can combine part-time window cleaning with
  part-time contracting, while another uses only contracting.

Keeping the references inside one normal Second Brain item means the planner
is included in the existing local storage, cloud sync, backups, exports, and
restore history without maintaining a separate data store.

## Calculations

Income is shown as both gross and estimated take-home pay:

```text
hourly annual income     = hourly rate × hours per week × weeks per year
annual salary            = annual amount
contractor annual income = price per contract × contracts per week × weeks per year
estimated take-home      = gross income × take-home percentage
monthly surplus          = estimated take-home / 12 − monthly living costs
```

The planner applies start cash and then monthly surplus to the selected goals
in the visible goal order. It records an estimated completion month for every
goal and an estimated month when all selected goals are funded. Any positive
surplus after that point is projected into retirement savings, using the
chosen annual return and retirement target.

These are planning estimates, not financial advice. In particular, contractor
income needs a realistic take-home percentage that accounts for tax, expenses,
insurance, and downtime.
