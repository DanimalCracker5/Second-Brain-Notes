/*
  Second Brain — life/life-planner.js

  A saved Life Paths workspace. It intentionally keeps reusable income paths,
  goals, and mix-and-match life plans inside one normal Second Brain item, so
  all existing sync, backup, import, and restore behaviour keeps working.
*/
(function (ns) {
  "use strict";

  var host = null;
  var MAX_FORECAST_MONTHS = 1200;
  var TABS = [
    ["overview", "Overview"],
    ["paths", "Income paths"],
    ["goals", "Goals"],
    ["plans", "Life plans"]
  ];
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/><path d="m17.5 8.5 2.5 2.5 3-4"/></svg>';

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function array(value) {
    return Array.isArray(value) ? value : [];
  }

  function number(value, fallback) {
    var parsed = typeof value === "number" ? value : parseFloat(value);
    return isFinite(parsed) ? parsed : (fallback || 0);
  }

  function positive(value, fallback) {
    return Math.max(0, number(value, fallback));
  }

  function bounded(value, min, max, fallback) {
    return Math.max(min, Math.min(max, number(value, fallback)));
  }

  function cents(value) {
    return Math.round(positive(value, 0) * 100);
  }

  function inputMoney(value) {
    value = Math.round(positive(value, 0));
    if (!value) return "";
    var dollars = value / 100;
    return dollars % 1 ? dollars.toFixed(2) : String(dollars);
  }

  function money(value) {
    value = positive(value, 0);
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      }).format(value / 100);
    } catch (error) {
      return "$" + Math.round(value / 100).toLocaleString();
    }
  }

  function compactMoney(value) {
    value = positive(value, 0) / 100;
    if (value >= 1000000) return "$" + (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + "M";
    if (value >= 1000) return "$" + (value / 1000).toFixed(value >= 100000 ? 0 : 1) + "k";
    return "$" + Math.round(value).toLocaleString();
  }

  function plural(value, single, multiple) {
    return value === 1 ? single : (multiple || single + "s");
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uniqueIds(values, allowed) {
    var seen = {}, out = [];
    array(values).forEach(function (id) {
      if (typeof id !== "string" || seen[id] || (allowed && !allowed[id])) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  function findById(values, id) {
    var list = array(values);
    for (var index = 0; index < list.length; index++) {
      if (list[index] && list[index].id === id) return list[index];
    }
    return null;
  }

  function makeNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function append(parent) {
    for (var index = 1; index < arguments.length; index++) {
      if (arguments[index]) parent.appendChild(arguments[index]);
    }
    return parent;
  }

  function button(label, className, onClick, title) {
    var node = makeNode("button", className || "lp-button", label);
    node.type = "button";
    if (title) {
      node.title = title;
      node.setAttribute("aria-label", title);
    }
    if (onClick) node.onclick = onClick;
    return node;
  }

  function staticIconButton(label, className, onClick, title) {
    var node = button(label, className, onClick, title || label);
    return node;
  }

  function setText(root, selector, value) {
    var node = root.querySelector(selector);
    if (node) node.textContent = value;
  }

  function moneyField(parent, label, value, placeholder, onInput) {
    var wrap = makeNode("label", "lp-field");
    var labelText = makeNode("span", "lp-field-label", label);
    var control = makeNode("span", "lp-money-input");
    var prefix = makeNode("span", "lp-input-prefix", "$");
    var input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.01";
    input.inputMode = "decimal";
    input.value = inputMoney(value);
    input.placeholder = placeholder || "0";
    input.addEventListener("input", function () {
      onInput(cents(input.value), input);
    });
    append(control, prefix, input);
    append(wrap, labelText, control);
    parent.appendChild(wrap);
    return input;
  }

  function numberField(parent, label, value, options, onInput) {
    options = options || {};
    var wrap = makeNode("label", "lp-field");
    var labelText = makeNode("span", "lp-field-label", label);
    var control = makeNode("span", "lp-number-input");
    var input = document.createElement("input");
    input.type = "number";
    input.min = options.min === undefined ? "0" : String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    input.step = options.step === undefined ? "1" : String(options.step);
    input.inputMode = "decimal";
    input.value = value === 0 && options.blankZero ? "" : String(value);
    input.placeholder = options.placeholder || "0";
    input.addEventListener("input", function () {
      onInput(number(input.value, 0), input);
    });
    control.appendChild(input);
    if (options.suffix) control.appendChild(makeNode("span", "lp-input-suffix", options.suffix));
    append(wrap, labelText, control);
    parent.appendChild(wrap);
    return input;
  }

  function textField(parent, label, value, placeholder, onInput, className) {
    var wrap = makeNode("label", "lp-field " + (className || ""));
    var labelText = makeNode("span", "lp-field-label", label);
    var input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.autocomplete = "off";
    input.addEventListener("input", function () {
      onInput(input.value, input);
    });
    append(wrap, labelText, input);
    parent.appendChild(wrap);
    return input;
  }

  function selectField(parent, label, value, choices, onChange) {
    var wrap = makeNode("label", "lp-field");
    var labelText = makeNode("span", "lp-field-label", label);
    var select = document.createElement("select");
    choices.forEach(function (choice) {
      var option = document.createElement("option");
      option.value = choice[0];
      option.textContent = choice[1];
      option.selected = choice[0] === value;
      select.appendChild(option);
    });
    select.addEventListener("change", function () {
      onChange(select.value, select);
    });
    append(wrap, labelText, select);
    parent.appendChild(wrap);
    return select;
  }

  function note(text, kind) {
    return makeNode("p", "lp-note" + (kind ? " " + kind : ""), text);
  }

  function sectionHeading(eyebrow, title, copyText, actions) {
    var head = makeNode("header", "lp-section-head");
    var text = makeNode("div", "lp-section-copy");
    if (eyebrow) text.appendChild(makeNode("p", "lp-eyebrow", eyebrow));
    text.appendChild(makeNode("h2", "", title));
    if (copyText) text.appendChild(makeNode("p", "", copyText));
    head.appendChild(text);
    if (actions) head.appendChild(actions);
    return head;
  }

  function newIncomePath() {
    return {
      id: host.uid(),
      name: "",
      type: "hourly",
      hourlyRateCents: 0,
      hoursPerWeek: 20,
      weeksPerYear: 52,
      annualSalaryCents: 0,
      contractPriceCents: 0,
      contractsPerWeek: 0,
      hoursPerContract: 0,
      takeHomePercent: 75
    };
  }

  function newGoal() {
    return {
      id: host.uid(),
      name: "",
      targetCents: 0,
      savedCents: 0
    };
  }

  function newPlan() {
    return {
      id: host.uid(),
      name: "New life plan",
      pathIds: [],
      goalIds: [],
      monthlyExpensesCents: 0,
      startingCashCents: 0,
      retirementTargetCents: 0,
      retirementSavingsCents: 0,
      annualReturnPercent: 5,
      currentAge: 30
    };
  }

  function newLifeData() {
    var plan = newPlan();
    return {
      version: 1,
      activeTab: "overview",
      activePlanId: plan.id,
      paths: [],
      goals: [],
      plans: [plan]
    };
  }

  function normalizePath(path) {
    if (!isObject(path)) path = {};
    if (!path.id) path.id = host.uid();
    path.name = typeof path.name === "string" ? path.name.slice(0, 100) : "";
    if (["hourly", "annual", "contractor"].indexOf(path.type) < 0) path.type = "hourly";
    path.hourlyRateCents = Math.round(positive(path.hourlyRateCents, 0));
    path.hoursPerWeek = bounded(path.hoursPerWeek, 0, 168, 20);
    path.weeksPerYear = bounded(path.weeksPerYear, 0, 52, 52);
    path.annualSalaryCents = Math.round(positive(path.annualSalaryCents, 0));
    path.contractPriceCents = Math.round(positive(path.contractPriceCents, 0));
    path.contractsPerWeek = bounded(path.contractsPerWeek, 0, 100, 0);
    path.hoursPerContract = bounded(path.hoursPerContract, 0, 168, 0);
    path.takeHomePercent = bounded(path.takeHomePercent, 0, 100, 75);
    return path;
  }

  function normalizeGoal(goal) {
    if (!isObject(goal)) goal = {};
    if (!goal.id) goal.id = host.uid();
    goal.name = typeof goal.name === "string" ? goal.name.slice(0, 100) : "";
    goal.targetCents = Math.round(positive(goal.targetCents, 0));
    goal.savedCents = Math.round(positive(goal.savedCents, 0));
    return goal;
  }

  function normalizePlan(plan, pathIds, goalIds) {
    if (!isObject(plan)) plan = {};
    if (!plan.id) plan.id = host.uid();
    plan.name = typeof plan.name === "string" && plan.name.trim() ? plan.name.slice(0, 100) : "Untitled life plan";
    plan.pathIds = uniqueIds(plan.pathIds, pathIds);
    plan.goalIds = uniqueIds(plan.goalIds, goalIds);
    plan.monthlyExpensesCents = Math.round(positive(plan.monthlyExpensesCents, 0));
    plan.startingCashCents = Math.round(positive(plan.startingCashCents, 0));
    plan.retirementTargetCents = Math.round(positive(plan.retirementTargetCents, 0));
    plan.retirementSavingsCents = Math.round(positive(plan.retirementSavingsCents, 0));
    plan.annualReturnPercent = bounded(plan.annualReturnPercent, 0, 30, 5);
    plan.currentAge = bounded(plan.currentAge, 0, 100, 30);
    return plan;
  }

  function normalizeItem(item) {
    if (!isObject(item.life)) item.life = newLifeData();
    var life = item.life;
    life.version = 1;
    life.paths = array(life.paths).map(normalizePath);
    life.goals = array(life.goals).map(normalizeGoal);
    var pathIds = {}, goalIds = {};
    life.paths.forEach(function (path) { pathIds[path.id] = true; });
    life.goals.forEach(function (goal) { goalIds[goal.id] = true; });
    life.plans = array(life.plans).map(function (plan) {
      return normalizePlan(plan, pathIds, goalIds);
    });
    if (!life.plans.length) life.plans.push(newPlan());
    if (["overview", "paths", "goals", "plans"].indexOf(life.activeTab) < 0) life.activeTab = "overview";
    if (!findById(life.plans, life.activePlanId)) life.activePlanId = life.plans[0].id;
    return life;
  }

  function activePlan(life) {
    return findById(life.plans, life.activePlanId) || life.plans[0];
  }

  function pathNumbers(path) {
    path = normalizePath(path);
    var gross = 0, hours = 0;
    if (path.type === "annual") {
      gross = path.annualSalaryCents;
    } else if (path.type === "contractor") {
      gross = path.contractPriceCents * path.contractsPerWeek * path.weeksPerYear;
      hours = path.contractsPerWeek * path.hoursPerContract;
    } else {
      gross = path.hourlyRateCents * path.hoursPerWeek * path.weeksPerYear;
      hours = path.hoursPerWeek;
    }
    return {
      grossCents: gross,
      netCents: gross * (path.takeHomePercent / 100),
      hoursPerWeek: hours
    };
  }

  function selectedItems(items, ids) {
    var byId = {};
    array(items).forEach(function (item) { if (item && item.id) byId[item.id] = item; });
    return uniqueIds(ids, byId).map(function (id) { return byId[id]; });
  }

  function forecast(life, plan) {
    plan = plan || activePlan(life);
    var paths = selectedItems(life.paths, plan.pathIds);
    var goals = selectedItems(life.goals, plan.goalIds);
    var annualGross = 0, annualNet = 0, workload = 0;
    paths.forEach(function (path) {
      var metrics = pathNumbers(path);
      annualGross += metrics.grossCents;
      annualNet += metrics.netCents;
      workload += metrics.hoursPerWeek;
    });
    var monthlyNet = annualNet / 12;
    var monthlyExpenses = plan.monthlyExpensesCents;
    var monthlySurplus = monthlyNet - monthlyExpenses;
    var goalStates = goals.map(function (goal) {
      return {
        goal: goal,
        remainingCents: Math.max(0, goal.targetCents - goal.savedCents),
        originalRemainingCents: Math.max(0, goal.targetCents - goal.savedCents),
        startingCashAppliedCents: 0,
        completionMonth: goal.savedCents >= goal.targetCents && goal.targetCents > 0 ? 0 : null
      };
    });
    var firstOpen = 0;
    while (firstOpen < goalStates.length && goalStates[firstOpen].remainingCents <= 0) firstOpen++;
    var allGoalsMonth = firstOpen >= goalStates.length ? 0 : null;
    var availableStartCash = plan.startingCashCents;
    var retirementBalance = plan.retirementSavingsCents;
    var retirementTarget = plan.retirementTargetCents;
    var retirementMonth = null;
    var monthlyReturn = Math.pow(1 + plan.annualReturnPercent / 100, 1 / 12) - 1;

    function applyToGoals(amount, month) {
      while (amount > 0 && firstOpen < goalStates.length) {
        var state = goalStates[firstOpen];
        var payment = Math.min(amount, state.remainingCents);
        if (month === 0) state.startingCashAppliedCents += payment;
        state.remainingCents -= payment;
        amount -= payment;
        if (state.remainingCents <= 0.01) {
          state.remainingCents = 0;
          state.completionMonth = month;
          firstOpen++;
        }
      }
      if (firstOpen >= goalStates.length && allGoalsMonth === null) allGoalsMonth = month;
      return amount;
    }

    if (firstOpen < goalStates.length) {
      availableStartCash = applyToGoals(availableStartCash, 0);
    }
    if (firstOpen >= goalStates.length) {
      allGoalsMonth = 0;
      retirementBalance += availableStartCash;
      if (retirementTarget > 0 && retirementBalance >= retirementTarget) retirementMonth = 0;
    }

    var month;
    for (month = 1; month <= MAX_FORECAST_MONTHS; month++) {
      if (firstOpen >= goalStates.length && (!retirementTarget || retirementMonth !== null)) break;
      if (monthlySurplus <= 0) break;
      retirementBalance = retirementBalance * (1 + monthlyReturn);
      var leftover = 0;
      if (firstOpen < goalStates.length) {
        leftover = applyToGoals(monthlySurplus, month);
      } else {
        leftover = monthlySurplus;
      }
      if (firstOpen >= goalStates.length) {
        retirementBalance += leftover;
        if (retirementTarget > 0 && retirementBalance >= retirementTarget && retirementMonth === null) retirementMonth = month;
      }
    }

    return {
      paths: paths,
      goals: goals,
      goalStates: goalStates,
      annualGrossCents: annualGross,
      annualNetCents: annualNet,
      monthlyNetCents: monthlyNet,
      monthlyExpensesCents: monthlyExpenses,
      monthlySurplusCents: monthlySurplus,
      workloadHoursPerWeek: workload,
      allGoalsMonth: allGoalsMonth,
      retirementTargetCents: retirementTarget,
      retirementBalanceCents: retirementBalance,
      retirementMonth: retirementMonth,
      projectionLimitReached: month > MAX_FORECAST_MONTHS
    };
  }

  function dateForMonth(month) {
    if (month === null || month === undefined) return "";
    if (month === 0) return "Now";
    var date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() + month);
    try {
      return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    } catch (error) {
      return date.getMonth() + 1 + "/" + date.getFullYear();
    }
  }

  function timeForMonth(month) {
    if (month === null || month === undefined) return "Not reached in this projection";
    if (month === 0) return "Ready now";
    var years = Math.floor(month / 12), months = month % 12, words = [];
    if (years) words.push(years + " " + plural(years, "yr", "yrs"));
    if (months) words.push(months + " " + plural(months, "mo", "mos"));
    return words.join(" ");
  }

  function ageForMonth(age, month) {
    if (month === null || month === undefined || !age) return "";
    return "age " + (age + month / 12).toFixed(1).replace(/\.0$/, "");
  }

  function persist(item, root, refresh) {
    host.touchItem(item);
    host.persist();
    host.renderList();
    if (refresh) refreshComputed(root, item);
  }

  function redraw(root, item, focusClass) {
    var next = build(item);
    if (root && root.parentNode) root.parentNode.replaceChild(next, root);
    if (focusClass) {
      var focus = next.querySelector(focusClass);
      if (focus) focus.focus();
    }
    return next;
  }

  function updateHero(root, item) {
    var life = normalizeItem(item);
    var plan = activePlan(life);
    var result = forecast(life, plan);
    setText(root, "[data-lp-hero-plan]", plan.name || "Untitled life plan");
    setText(root, "[data-lp-hero-net]", money(result.monthlyNetCents));
    setText(root, "[data-lp-hero-surplus]", (result.monthlySurplusCents >= 0 ? "" : "−") + money(Math.abs(result.monthlySurplusCents)));
    setText(root, "[data-lp-hero-surplus-label]", result.monthlySurplusCents >= 0 ? "available each month" : "short each month");
    setText(root, "[data-lp-hero-count]", result.paths.length + " income " + plural(result.paths.length, "path"));
  }

  function refreshComputed(root, item) {
    if (!root || !root.isConnected) return;
    updateHero(root, item);
    var oldForecast = root.querySelector("[data-lp-forecast]");
    if (oldForecast && oldForecast.parentNode) {
      var life = normalizeItem(item);
      oldForecast.parentNode.replaceChild(buildForecast(life, activePlan(life)), oldForecast);
    }
  }

  function metric(label, value, detail, accent) {
    var card = makeNode("article", "lp-metric" + (accent ? " accent" : ""));
    card.appendChild(makeNode("span", "lp-metric-label", label));
    card.appendChild(makeNode("strong", "lp-metric-value", value));
    if (detail) card.appendChild(makeNode("small", "lp-metric-detail", detail));
    return card;
  }

  function buildHero(item, root) {
    var life = normalizeItem(item);
    var plan = activePlan(life);
    var result = forecast(life, plan);
    var hero = makeNode("section", "lp-hero");
    hero.setAttribute("data-lp-hero", "");
    var heroCopy = makeNode("div", "lp-hero-copy");
    heroCopy.appendChild(makeNode("p", "lp-eyebrow", "Life Paths"));
    heroCopy.appendChild(makeNode("h2", "", "Map the work that funds your life."));
    heroCopy.appendChild(makeNode("p", "lp-hero-description", "Create reusable work paths, add goals once, then compare different income mixes without rebuilding the math."));
    hero.appendChild(heroCopy);
    var heroStats = makeNode("div", "lp-hero-stats");
    var viewing = makeNode("div", "lp-hero-plan");
    viewing.appendChild(makeNode("span", "lp-hero-stat-label", "Viewing"));
    var planSelect = document.createElement("select");
    planSelect.setAttribute("aria-label", "Active life plan");
    life.plans.forEach(function (candidate) {
      var option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.name || "Untitled life plan";
      option.selected = candidate.id === plan.id;
      planSelect.appendChild(option);
    });
    planSelect.onchange = function () {
      life.activePlanId = planSelect.value;
      persist(item, root, false);
      redraw(root, item);
    };
    viewing.appendChild(planSelect);
    heroStats.appendChild(viewing);
    var net = makeNode("div", "lp-hero-stat");
    net.appendChild(makeNode("span", "lp-hero-stat-label", "Take-home / month"));
    net.appendChild(makeNode("strong", "lp-hero-stat-value", money(result.monthlyNetCents)));
    net.lastChild.setAttribute("data-lp-hero-net", "");
    heroStats.appendChild(net);
    var surplus = makeNode("div", "lp-hero-stat");
    surplus.appendChild(makeNode("span", "lp-hero-stat-label", "Cash flow"));
    var surplusValue = makeNode("strong", "lp-hero-stat-value", (result.monthlySurplusCents >= 0 ? "" : "−") + money(Math.abs(result.monthlySurplusCents)));
    surplusValue.setAttribute("data-lp-hero-surplus", "");
    surplus.appendChild(surplusValue);
    var surplusLabel = makeNode("small", "", result.monthlySurplusCents >= 0 ? "available each month" : "short each month");
    surplusLabel.setAttribute("data-lp-hero-surplus-label", "");
    surplus.appendChild(surplusLabel);
    heroStats.appendChild(surplus);
    hero.appendChild(heroStats);
    return hero;
  }

  function buildTabs(item, root) {
    var life = normalizeItem(item);
    var nav = makeNode("nav", "lp-tabs");
    nav.setAttribute("aria-label", "Life Paths sections");
    TABS.forEach(function (tab) {
      var isCurrent = life.activeTab === tab[0];
      var tabButton = button(tab[1], "lp-tab" + (isCurrent ? " on" : ""), function () {
        if (life.activeTab === tab[0]) return;
        life.activeTab = tab[0];
        persist(item, root, false);
        redraw(root, item);
      });
      tabButton.setAttribute("aria-current", isCurrent ? "page" : "false");
      nav.appendChild(tabButton);
    });
    return nav;
  }

  function buildForecast(life, plan) {
    var result = forecast(life, plan);
    var section = makeNode("section", "lp-forecast");
    section.setAttribute("data-lp-forecast", "");
    var title = makeNode("div", "lp-forecast-title");
    title.appendChild(makeNode("p", "lp-eyebrow", "Plan forecast"));
    title.appendChild(makeNode("h3", "", plan.name || "Untitled life plan"));
    title.appendChild(makeNode("p", "lp-muted", "Dates are estimates in today’s dollars. Change a rate, hours, costs, or goals and the forecast updates immediately."));
    section.appendChild(title);

    var metrics = makeNode("div", "lp-metric-grid");
    metrics.appendChild(metric("Gross income / year", money(result.annualGrossCents), result.paths.length ? result.paths.length + " selected " + plural(result.paths.length, "path") : "Choose income paths"));
    metrics.appendChild(metric("Estimated take-home / year", money(result.annualNetCents), "After each path’s take-home percentage"));
    metrics.appendChild(metric("Living costs / month", money(result.monthlyExpensesCents), "Used before goals and retirement"));
    metrics.appendChild(metric("Surplus / month", (result.monthlySurplusCents >= 0 ? "" : "−") + money(Math.abs(result.monthlySurplusCents)), result.monthlySurplusCents >= 0 ? "Available to your selected goals" : "Income does not cover costs", result.monthlySurplusCents >= 0));
    section.appendChild(metrics);

    if (!result.paths.length) {
      section.appendChild(note("Choose one or more income paths in Life plans to see a real forecast.", "warn"));
    } else if (result.monthlySurplusCents < 0) {
      section.appendChild(note("This mix is " + money(Math.abs(result.monthlySurplusCents)) + " short every month before goals. Reduce costs or increase estimated take-home before relying on a completion date.", "danger"));
    } else if (result.monthlySurplusCents === 0) {
      section.appendChild(note("This mix covers living costs, but does not yet leave money for selected goals or retirement.", "warn"));
    } else {
      section.appendChild(note(money(result.monthlySurplusCents) + " per month goes to selected goals in priority order, then continues toward retirement.", "success"));
    }

    var timeline = makeNode("section", "lp-timeline");
    var timelineHead = makeNode("div", "lp-subhead");
    timelineHead.appendChild(makeNode("div", "", "Goal timeline"));
    timelineHead.appendChild(makeNode("small", "", result.goals.length ? result.goals.length + " selected" : "Nothing selected"));
    timeline.appendChild(timelineHead);
    if (!result.goals.length) {
      timeline.appendChild(note("Select goals for this life plan in the Life plans tab. Your goal library stays reusable across every plan.", "plain"));
    } else {
      result.goalStates.forEach(function (state, index) {
        var goal = state.goal;
        var row = makeNode("article", "lp-timeline-row");
        var marker = makeNode("span", "lp-timeline-marker", String(index + 1));
        var body = makeNode("div", "lp-timeline-body");
        var top = makeNode("div", "lp-timeline-top");
        top.appendChild(makeNode("strong", "", goal.name || "Untitled goal"));
        var status = state.completionMonth === null ? "Needs positive surplus" : (state.completionMonth === 0 ? "Ready now" : "Around " + dateForMonth(state.completionMonth));
        top.appendChild(makeNode("span", "lp-timeline-date" + (state.completionMonth === null ? " muted" : ""), status));
        body.appendChild(top);
        var progress = goal.targetCents ? Math.min(100, Math.round(goal.savedCents / goal.targetCents * 100)) : 0;
        var bar = makeNode("div", "lp-progress");
        var fill = makeNode("span", "");
        fill.style.width = progress + "%";
        bar.appendChild(fill);
        body.appendChild(bar);
        var detail = money(goal.savedCents) + " saved · " + money(state.originalRemainingCents) + " remaining";
        if (state.startingCashAppliedCents) detail += " · " + money(state.startingCashAppliedCents) + " applied from start cash";
        body.appendChild(makeNode("small", "lp-muted", detail));
        append(row, marker, body);
        timeline.appendChild(row);
      });
      var allGoals = makeNode("div", "lp-all-goals");
      allGoals.appendChild(makeNode("span", "lp-all-goals-label", "All selected goals"));
      var allText = result.allGoalsMonth === null ? "Not funded with this cash flow" : (result.allGoalsMonth === 0 ? "Complete now" : dateForMonth(result.allGoalsMonth) + " · " + timeForMonth(result.allGoalsMonth));
      allGoals.appendChild(makeNode("strong", result.allGoalsMonth === null ? "lp-danger-text" : "", allText));
      timeline.appendChild(allGoals);
    }
    section.appendChild(timeline);

    var retirement = makeNode("section", "lp-retirement");
    var retirementHead = makeNode("div", "lp-subhead");
    retirementHead.appendChild(makeNode("div", "", "Retirement after goals"));
    retirementHead.appendChild(makeNode("small", "", "Optional target"));
    retirement.appendChild(retirementHead);
    if (!plan.retirementTargetCents) {
      retirement.appendChild(note("Set a retirement target in Life plans to turn the post-goal surplus into an estimated retirement date.", "plain"));
    } else if (result.allGoalsMonth === null) {
      retirement.appendChild(note("The retirement estimate waits until all selected goals are funded. This plan needs positive goal funding first.", "warn"));
    } else if (result.retirementMonth === null) {
      retirement.appendChild(note("This plan does not reach " + money(plan.retirementTargetCents) + " within 100 years at the current assumptions.", "warn"));
    } else {
      var retirementGrid = makeNode("div", "lp-retirement-grid");
      retirementGrid.appendChild(metric("Retirement target", money(plan.retirementTargetCents), money(plan.retirementSavingsCents) + " already invested"));
      retirementGrid.appendChild(metric("Estimated target date", dateForMonth(result.retirementMonth), timeForMonth(result.retirementMonth) + (plan.currentAge ? " · " + ageForMonth(plan.currentAge, result.retirementMonth) : ""), true));
      retirement.appendChild(retirementGrid);
    }
    section.appendChild(retirement);
    if (result.workloadHoursPerWeek > 60) {
      section.appendChild(note("Selected work adds up to about " + result.workloadHoursPerWeek.toFixed(1).replace(/\.0$/, "") + " scheduled hours per week. Check that this mix is workable for you.", "warn"));
    }
    return section;
  }

  function buildOverview(item, root) {
    var life = normalizeItem(item);
    var plan = activePlan(life);
    var wrap = makeNode("div", "lp-stage lp-overview");
    var actions = makeNode("div", "lp-actions");
    actions.appendChild(button("+ Income path", "lp-button", function () {
      life.paths.push(newIncomePath());
      life.activeTab = "paths";
      persist(item, root, false);
      redraw(root, item, ".lp-path-name");
    }));
    actions.appendChild(button("+ Goal", "lp-button quiet", function () {
      life.goals.push(newGoal());
      life.activeTab = "goals";
      persist(item, root, false);
      redraw(root, item, ".lp-goal-name");
    }));
    actions.appendChild(button("+ Life plan", "lp-button quiet", function () {
      var candidate = newPlan();
      candidate.name = "Life plan " + (life.plans.length + 1);
      life.plans.push(candidate);
      life.activePlanId = candidate.id;
      life.activeTab = "plans";
      persist(item, root, false);
      redraw(root, item, ".lp-plan-name");
    }));
    wrap.appendChild(sectionHeading("Start here", "Build a few possible lives.", "Each plan can combine the same work paths and goals differently, so you can compare a part-time mix against a full-time option without recreating anything.", actions));
    if (!life.paths.length || !life.goals.length) {
      var setup = makeNode("div", "lp-setup-grid");
      var pathSetup = makeNode("article", "lp-setup-card" + (!life.paths.length ? " needs" : ""));
      pathSetup.appendChild(makeNode("span", "lp-setup-step", "1"));
      pathSetup.appendChild(makeNode("strong", "", "Add income paths"));
      pathSetup.appendChild(makeNode("p", "", "A path can be window cleaning, a salary, or contractor work. Create each once."));
      pathSetup.appendChild(makeNode("small", "", life.paths.length ? life.paths.length + " ready" : "No paths yet"));
      setup.appendChild(pathSetup);
      var goalSetup = makeNode("article", "lp-setup-card" + (!life.goals.length ? " needs" : ""));
      goalSetup.appendChild(makeNode("span", "lp-setup-step", "2"));
      goalSetup.appendChild(makeNode("strong", "", "Add goals"));
      goalSetup.appendChild(makeNode("p", "", "For example: Buy a house, $250,000; Buy a Tesla, $15,000."));
      goalSetup.appendChild(makeNode("small", "", life.goals.length ? life.goals.length + " ready" : "No goals yet"));
      setup.appendChild(goalSetup);
      var planSetup = makeNode("article", "lp-setup-card");
      planSetup.appendChild(makeNode("span", "lp-setup-step", "3"));
      planSetup.appendChild(makeNode("strong", "", "Mix them in a plan"));
      planSetup.appendChild(makeNode("p", "", "Pick any paths and goals, then set living costs and retirement assumptions."));
      planSetup.appendChild(makeNode("small", "", plan.name || "Current plan"));
      setup.appendChild(planSetup);
      wrap.appendChild(setup);
    }
    wrap.appendChild(buildForecast(life, plan));
    return wrap;
  }

  function pathSummary(path) {
    var metrics = pathNumbers(path);
    return money(metrics.grossCents) + " gross / year · " + money(metrics.netCents) + " estimated take-home / year";
  }

  function updatePathSummary(card, path) {
    var node = card.querySelector("[data-lp-path-summary]");
    if (node) node.textContent = pathSummary(path);
  }

  function buildPathCard(item, root, life, path, index) {
    var card = makeNode("article", "lp-path-card");
    var top = makeNode("div", "lp-card-top");
    var nameWrap = makeNode("label", "lp-name-field");
    nameWrap.appendChild(makeNode("span", "lp-field-label", "Income path " + (index + 1)));
    var name = document.createElement("input");
    name.type = "text";
    name.value = path.name || "";
    name.placeholder = "e.g. Part-time window cleaning";
    name.className = "lp-path-name";
    name.addEventListener("input", function () {
      path.name = name.value.slice(0, 100);
      persist(item, root, false);
    });
    nameWrap.appendChild(name);
    top.appendChild(nameWrap);
    var cardActions = makeNode("div", "lp-card-actions");
    cardActions.appendChild(staticIconButton("Duplicate", "lp-icon-button", function () {
      var cloned = copy(path);
      cloned.id = host.uid();
      cloned.name = (cloned.name || "Income path") + " copy";
      life.paths.splice(index + 1, 0, cloned);
      persist(item, root, false);
      redraw(root, item);
    }, "Duplicate income path"));
    cardActions.appendChild(staticIconButton("Remove", "lp-icon-button danger", function () {
      if (!window.confirm("Remove this income path from every life plan?")) return;
      life.paths = life.paths.filter(function (candidate) { return candidate.id !== path.id; });
      life.plans.forEach(function (plan) {
        plan.pathIds = plan.pathIds.filter(function (id) { return id !== path.id; });
      });
      persist(item, root, false);
      redraw(root, item);
    }, "Remove income path"));
    top.appendChild(cardActions);
    card.appendChild(top);
    var fields = makeNode("div", "lp-fields-grid");
    selectField(fields, "Paid as", path.type, [
      ["hourly", "Hourly work"],
      ["annual", "Annual salary"],
      ["contractor", "Contractor work"]
    ], function (value) {
      path.type = value;
      persist(item, root, false);
      redraw(root, item);
    });
    if (path.type === "annual") {
      moneyField(fields, "Annual salary", path.annualSalaryCents, "e.g. 65000", function (value) {
        path.annualSalaryCents = value;
        persist(item, root, true);
        updatePathSummary(card, path);
      });
    } else if (path.type === "contractor") {
      moneyField(fields, "Price per contract", path.contractPriceCents, "e.g. 1500", function (value) {
        path.contractPriceCents = value;
        persist(item, root, true);
        updatePathSummary(card, path);
      });
      numberField(fields, "Contracts / week", path.contractsPerWeek, { step: 0.25, placeholder: "e.g. 2" }, function (value) {
        path.contractsPerWeek = bounded(value, 0, 100, 0);
        persist(item, root, true);
        updatePathSummary(card, path);
      });
      numberField(fields, "Weeks / year", path.weeksPerYear, { min: 0, max: 52, step: 1, placeholder: "52" }, function (value) {
        path.weeksPerYear = bounded(value, 0, 52, 52);
        persist(item, root, true);
        updatePathSummary(card, path);
      });
      numberField(fields, "Hours / contract", path.hoursPerContract, { step: 0.5, suffix: "hrs", placeholder: "Optional" }, function (value) {
        path.hoursPerContract = bounded(value, 0, 168, 0);
        persist(item, root, true);
        updatePathSummary(card, path);
      });
    } else {
      moneyField(fields, "Hourly rate", path.hourlyRateCents, "e.g. 35", function (value) {
        path.hourlyRateCents = value;
        persist(item, root, true);
        updatePathSummary(card, path);
      });
      numberField(fields, "Hours / week", path.hoursPerWeek, { min: 0, max: 168, step: 0.5, suffix: "hrs", placeholder: "20" }, function (value) {
        path.hoursPerWeek = bounded(value, 0, 168, 20);
        persist(item, root, true);
        updatePathSummary(card, path);
      });
      numberField(fields, "Weeks / year", path.weeksPerYear, { min: 0, max: 52, step: 1, placeholder: "52" }, function (value) {
        path.weeksPerYear = bounded(value, 0, 52, 52);
        persist(item, root, true);
        updatePathSummary(card, path);
      });
    }
    numberField(fields, "Estimated take-home", path.takeHomePercent, { min: 0, max: 100, step: 1, suffix: "%", placeholder: "75" }, function (value) {
      path.takeHomePercent = bounded(value, 0, 100, 75);
      persist(item, root, true);
      updatePathSummary(card, path);
    });
    card.appendChild(fields);
    var summary = makeNode("p", "lp-path-summary", pathSummary(path));
    summary.setAttribute("data-lp-path-summary", "");
    card.appendChild(summary);
    card.appendChild(note("Estimated take-home is the share you keep after taxes, business costs, insurance, and unpaid time. Make it conservative for contract work.", "plain"));
    return card;
  }

  function buildPaths(item, root) {
    var life = normalizeItem(item);
    var wrap = makeNode("div", "lp-stage");
    var actions = makeNode("div", "lp-actions");
    actions.appendChild(button("+ Add income path", "lp-button", function () {
      life.paths.push(newIncomePath());
      persist(item, root, false);
      redraw(root, item, ".lp-path-name");
    }));
    wrap.appendChild(sectionHeading("Reusable earning blocks", "Income paths", "Create each way you earn once. A life plan can combine any number of these paths, including two part-time paths.", actions));
    if (!life.paths.length) {
      var empty = makeNode("div", "lp-empty-state");
      empty.appendChild(makeNode("strong", "", "No income paths yet."));
      empty.appendChild(makeNode("p", "", "Start with the work you know: a wage, annual salary, or contractor scale."));
      empty.appendChild(button("Create first income path", "lp-button", function () {
        life.paths.push(newIncomePath());
        persist(item, root, false);
        redraw(root, item, ".lp-path-name");
      }));
      wrap.appendChild(empty);
      return wrap;
    }
    var list = makeNode("div", "lp-card-list");
    life.paths.forEach(function (path, index) {
      list.appendChild(buildPathCard(item, root, life, path, index));
    });
    wrap.appendChild(list);
    return wrap;
  }

  function goalProgress(goal) {
    if (!goal.targetCents) return 0;
    return Math.min(100, Math.round(goal.savedCents / goal.targetCents * 100));
  }

  function updateGoalCard(card, goal) {
    var progress = goalProgress(goal);
    var fill = card.querySelector("[data-lp-goal-fill]");
    if (fill) fill.style.width = progress + "%";
    setText(card, "[data-lp-goal-percent]", progress + "% funded");
    setText(card, "[data-lp-goal-remaining]", money(Math.max(0, goal.targetCents - goal.savedCents)) + " remaining");
  }

  function buildGoalCard(item, root, life, goal, index) {
    var card = makeNode("article", "lp-goal-card");
    var top = makeNode("div", "lp-card-top");
    var nameWrap = makeNode("label", "lp-name-field");
    nameWrap.appendChild(makeNode("span", "lp-field-label", "Goal " + (index + 1)));
    var name = document.createElement("input");
    name.type = "text";
    name.value = goal.name || "";
    name.placeholder = "e.g. Buy a house";
    name.className = "lp-goal-name";
    name.addEventListener("input", function () {
      goal.name = name.value.slice(0, 100);
      persist(item, root, false);
    });
    nameWrap.appendChild(name);
    top.appendChild(nameWrap);
    var cardActions = makeNode("div", "lp-card-actions");
    cardActions.appendChild(staticIconButton("Duplicate", "lp-icon-button", function () {
      var cloned = copy(goal);
      cloned.id = host.uid();
      cloned.name = (cloned.name || "Goal") + " copy";
      life.goals.splice(index + 1, 0, cloned);
      persist(item, root, false);
      redraw(root, item);
    }, "Duplicate goal"));
    cardActions.appendChild(staticIconButton("Remove", "lp-icon-button danger", function () {
      if (!window.confirm("Remove this goal from every life plan?")) return;
      life.goals = life.goals.filter(function (candidate) { return candidate.id !== goal.id; });
      life.plans.forEach(function (plan) {
        plan.goalIds = plan.goalIds.filter(function (id) { return id !== goal.id; });
      });
      persist(item, root, false);
      redraw(root, item);
    }, "Remove goal"));
    top.appendChild(cardActions);
    card.appendChild(top);
    var fields = makeNode("div", "lp-fields-grid two");
    moneyField(fields, "Target cost", goal.targetCents, "e.g. 250000", function (value) {
      goal.targetCents = value;
      persist(item, root, true);
      updateGoalCard(card, goal);
    });
    moneyField(fields, "Already saved", goal.savedCents, "e.g. 5000", function (value) {
      goal.savedCents = value;
      persist(item, root, true);
      updateGoalCard(card, goal);
    });
    card.appendChild(fields);
    var progressBlock = makeNode("div", "lp-goal-progress");
    var progressTop = makeNode("div", "lp-goal-progress-top");
    var percent = makeNode("strong", "", goalProgress(goal) + "% funded");
    percent.setAttribute("data-lp-goal-percent", "");
    var remaining = makeNode("span", "", money(Math.max(0, goal.targetCents - goal.savedCents)) + " remaining");
    remaining.setAttribute("data-lp-goal-remaining", "");
    append(progressTop, percent, remaining);
    var bar = makeNode("div", "lp-progress");
    var fill = makeNode("span", "");
    fill.style.width = goalProgress(goal) + "%";
    fill.setAttribute("data-lp-goal-fill", "");
    bar.appendChild(fill);
    append(progressBlock, progressTop, bar);
    card.appendChild(progressBlock);
    return card;
  }

  function buildGoals(item, root) {
    var life = normalizeItem(item);
    var wrap = makeNode("div", "lp-stage");
    var actions = makeNode("div", "lp-actions");
    actions.appendChild(button("+ Add goal", "lp-button", function () {
      life.goals.push(newGoal());
      persist(item, root, false);
      redraw(root, item, ".lp-goal-name");
    }));
    wrap.appendChild(sectionHeading("Shared targets", "Goals", "Add each big purchase or savings target once, then choose it in any life plan. The amount already saved stays shared.", actions));
    if (!life.goals.length) {
      var empty = makeNode("div", "lp-empty-state");
      empty.appendChild(makeNode("strong", "", "No goals yet."));
      empty.appendChild(makeNode("p", "", "Try “Buy a house” at $250,000 or “Buy a Tesla” at $15,000."));
      empty.appendChild(button("Create first goal", "lp-button", function () {
        life.goals.push(newGoal());
        persist(item, root, false);
        redraw(root, item, ".lp-goal-name");
      }));
      wrap.appendChild(empty);
      return wrap;
    }
    var list = makeNode("div", "lp-card-list");
    life.goals.forEach(function (goal, index) {
      list.appendChild(buildGoalCard(item, root, life, goal, index));
    });
    wrap.appendChild(list);
    return wrap;
  }

  function choiceRow(labelText, detail, checked, onChange, indexLabel) {
    var row = makeNode("label", "lp-choice-row" + (checked ? " checked" : ""));
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", function () {
      onChange(checkbox.checked);
    });
    var mark = makeNode("span", "lp-choice-check", "");
    var copyBlock = makeNode("span", "lp-choice-copy");
    var top = makeNode("span", "lp-choice-top");
    if (indexLabel) top.appendChild(makeNode("span", "lp-choice-index", indexLabel));
    top.appendChild(makeNode("strong", "", labelText));
    copyBlock.appendChild(top);
    if (detail) copyBlock.appendChild(makeNode("small", "", detail));
    append(row, checkbox, mark, copyBlock);
    return row;
  }

  function planCardButton(item, root, life, plan) {
    var buttonNode = button("", "lp-plan-pill" + (plan.id === life.activePlanId ? " on" : ""), function () {
      if (life.activePlanId === plan.id) return;
      life.activePlanId = plan.id;
      persist(item, root, false);
      redraw(root, item);
    });
    buttonNode.appendChild(makeNode("strong", "", plan.name || "Untitled life plan"));
    buttonNode.appendChild(makeNode("small", "", plan.pathIds.length + " paths · " + plan.goalIds.length + " goals"));
    return buttonNode;
  }

  function moveGoal(plan, goalId, direction) {
    var index = plan.goalIds.indexOf(goalId), target = index + direction;
    if (index < 0 || target < 0 || target >= plan.goalIds.length) return false;
    var previous = plan.goalIds[index];
    plan.goalIds[index] = plan.goalIds[target];
    plan.goalIds[target] = previous;
    return true;
  }

  function buildPlanSettings(item, root, life, plan) {
    var section = makeNode("section", "lp-plan-editor");
    var intro = makeNode("div", "lp-plan-intro");
    intro.appendChild(makeNode("p", "lp-eyebrow", "Active mix"));
    intro.appendChild(makeNode("h3", "", "Choose what this life looks like."));
    intro.appendChild(makeNode("p", "", "A plan can reuse any income paths and goals. It keeps its own living costs, starting cash, and retirement assumption."));
    section.appendChild(intro);

    var basics = makeNode("div", "lp-fields-grid plan-basics");
    var planNameInput = textField(basics, "Life plan name", plan.name, "e.g. Part-time mix", function (value) {
      plan.name = value.trim() ? value.slice(0, 100) : "Untitled life plan";
      persist(item, root, false);
      updateHero(root, item);
    }, "wide");
    planNameInput.className = "lp-plan-name";
    moneyField(basics, "Monthly living costs", plan.monthlyExpensesCents, "e.g. 2500", function (value) {
      plan.monthlyExpensesCents = value;
      persist(item, root, true);
    });
    moneyField(basics, "Start cash for goals", plan.startingCashCents, "Optional", function (value) {
      plan.startingCashCents = value;
      persist(item, root, true);
    });
    moneyField(basics, "Retirement target", plan.retirementTargetCents, "Optional", function (value) {
      plan.retirementTargetCents = value;
      persist(item, root, true);
    });
    moneyField(basics, "Retirement already saved", plan.retirementSavingsCents, "Optional", function (value) {
      plan.retirementSavingsCents = value;
      persist(item, root, true);
    });
    numberField(basics, "Expected annual return", plan.annualReturnPercent, { min: 0, max: 30, step: 0.1, suffix: "%", placeholder: "5" }, function (value) {
      plan.annualReturnPercent = bounded(value, 0, 30, 5);
      persist(item, root, true);
    });
    numberField(basics, "Your current age", plan.currentAge, { min: 0, max: 100, step: 1, placeholder: "30" }, function (value) {
      plan.currentAge = bounded(value, 0, 100, 30);
      persist(item, root, true);
    });
    section.appendChild(basics);
    section.appendChild(note("Retirement target is separate from purchase goals. The planner starts applying the post-goal surplus toward it only after all selected goals are funded.", "plain"));

    var sources = makeNode("section", "lp-selection-section");
    var sourcesHead = makeNode("div", "lp-selection-head");
    sourcesHead.appendChild(makeNode("div", "", "Income paths"));
    var sourceActions = makeNode("div", "lp-inline-actions");
    sourceActions.appendChild(button("Select all", "lp-text-button", function () {
      plan.pathIds = life.paths.map(function (path) { return path.id; });
      persist(item, root, true);
      redraw(root, item);
    }));
    sourceActions.appendChild(button("Clear", "lp-text-button", function () {
      plan.pathIds = [];
      persist(item, root, true);
      redraw(root, item);
    }));
    sourcesHead.appendChild(sourceActions);
    sources.appendChild(sourcesHead);
    if (!life.paths.length) {
      sources.appendChild(note("Create income paths first, then return here to combine them.", "plain"));
    } else {
      var choices = makeNode("div", "lp-choice-list");
      life.paths.forEach(function (path) {
        var pathMetrics = pathNumbers(path);
        var checked = plan.pathIds.indexOf(path.id) >= 0;
        choices.appendChild(choiceRow(path.name || "Untitled income path", money(pathMetrics.netCents) + " estimated take-home / year", checked, function (next) {
          if (next) plan.pathIds = uniqueIds(plan.pathIds.concat([path.id]));
          else plan.pathIds = plan.pathIds.filter(function (id) { return id !== path.id; });
          persist(item, root, true);
          redraw(root, item);
        }));
      });
      sources.appendChild(choices);
    }
    section.appendChild(sources);

    var goals = makeNode("section", "lp-selection-section");
    var goalsHead = makeNode("div", "lp-selection-head");
    goalsHead.appendChild(makeNode("div", "", "Goals, in funding order"));
    var goalActions = makeNode("div", "lp-inline-actions");
    goalActions.appendChild(button("Select all", "lp-text-button", function () {
      plan.goalIds = life.goals.map(function (goal) { return goal.id; });
      persist(item, root, true);
      redraw(root, item);
    }));
    goalActions.appendChild(button("Clear", "lp-text-button", function () {
      plan.goalIds = [];
      persist(item, root, true);
      redraw(root, item);
    }));
    goalsHead.appendChild(goalActions);
    goals.appendChild(goalsHead);
    if (!life.goals.length) {
      goals.appendChild(note("Create goals first, then select the goals this plan should fund.", "plain"));
    } else {
      var choices = makeNode("div", "lp-choice-list");
      life.goals.forEach(function (goal) {
        var selectedIndex = plan.goalIds.indexOf(goal.id);
        choices.appendChild(choiceRow(goal.name || "Untitled goal", money(goal.targetCents) + " target · " + money(goal.savedCents) + " saved", selectedIndex >= 0, function (next) {
          if (next) plan.goalIds = uniqueIds(plan.goalIds.concat([goal.id]));
          else plan.goalIds = plan.goalIds.filter(function (id) { return id !== goal.id; });
          persist(item, root, true);
          redraw(root, item);
        }, selectedIndex >= 0 ? String(selectedIndex + 1) : ""));
      });
      goals.appendChild(choices);
    }
    if (plan.goalIds.length > 1) {
      var order = makeNode("div", "lp-goal-order");
      order.appendChild(makeNode("small", "lp-field-label", "Change priority without dragging"));
      plan.goalIds.forEach(function (goalId, index) {
        var goal = findById(life.goals, goalId);
        if (!goal) return;
        var row = makeNode("div", "lp-order-row");
        row.appendChild(makeNode("strong", "", (index + 1) + ". " + (goal.name || "Untitled goal")));
        var orderActions = makeNode("div", "lp-order-actions");
        var up = staticIconButton("↑", "lp-order-button", function () {
          if (!moveGoal(plan, goal.id, -1)) return;
          persist(item, root, true);
          redraw(root, item);
        }, "Move goal earlier");
        up.disabled = index === 0;
        var down = staticIconButton("↓", "lp-order-button", function () {
          if (!moveGoal(plan, goal.id, 1)) return;
          persist(item, root, true);
          redraw(root, item);
        }, "Move goal later");
        down.disabled = index === plan.goalIds.length - 1;
        append(orderActions, up, down);
        append(row, orderActions);
        order.appendChild(row);
      });
      goals.appendChild(order);
    }
    section.appendChild(goals);
    return section;
  }

  function buildPlans(item, root) {
    var life = normalizeItem(item);
    var plan = activePlan(life);
    var wrap = makeNode("div", "lp-stage");
    var actions = makeNode("div", "lp-actions");
    actions.appendChild(button("+ New life plan", "lp-button", function () {
      var candidate = newPlan();
      candidate.name = "Life plan " + (life.plans.length + 1);
      life.plans.push(candidate);
      life.activePlanId = candidate.id;
      persist(item, root, false);
      redraw(root, item, ".lp-plan-name");
    }));
    wrap.appendChild(sectionHeading("Compare combinations", "Life plans", "Use plans for the different versions of life you want to compare. Each one can mix the same income paths and goals differently.", actions));
    var planStrip = makeNode("div", "lp-plan-strip");
    life.plans.forEach(function (candidate) {
      planStrip.appendChild(planCardButton(item, root, life, candidate));
    });
    wrap.appendChild(planStrip);
    var planActions = makeNode("div", "lp-plan-actions");
    planActions.appendChild(button("Duplicate this plan", "lp-button quiet", function () {
      var cloned = copy(plan);
      cloned.id = host.uid();
      cloned.name = (cloned.name || "Life plan") + " copy";
      life.plans.push(cloned);
      life.activePlanId = cloned.id;
      persist(item, root, false);
      redraw(root, item);
    }));
    if (life.plans.length > 1) {
      planActions.appendChild(button("Remove this plan", "lp-button danger-outline", function () {
        if (!window.confirm("Remove this life plan? Its income paths and goals will stay available.")) return;
        life.plans = life.plans.filter(function (candidate) { return candidate.id !== plan.id; });
        life.activePlanId = life.plans[0].id;
        persist(item, root, false);
        redraw(root, item);
      }));
    }
    wrap.appendChild(planActions);
    wrap.appendChild(buildPlanSettings(item, root, life, plan));
    wrap.appendChild(buildForecast(life, plan));
    return wrap;
  }

  function build(item) {
    var life = normalizeItem(item);
    var root = makeNode("section", "lp-root");
    root.setAttribute("data-item-editor", item.id);
    root.appendChild(buildHero(item, root));
    root.appendChild(buildTabs(item, root));
    if (life.activeTab === "paths") root.appendChild(buildPaths(item, root));
    else if (life.activeTab === "goals") root.appendChild(buildGoals(item, root));
    else if (life.activeTab === "plans") root.appendChild(buildPlans(item, root));
    else root.appendChild(buildOverview(item, root));
    return root;
  }

  function plannerText(item) {
    var life = normalizeItem(item);
    var lines = [];
    life.paths.forEach(function (path) {
      lines.push("Income path: " + (path.name || "Untitled") + " — " + pathSummary(path));
    });
    life.goals.forEach(function (goal) {
      lines.push("Goal: " + (goal.name || "Untitled") + " — " + money(goal.targetCents) + " target, " + money(goal.savedCents) + " saved");
    });
    life.plans.forEach(function (plan) {
      var result = forecast(life, plan);
      lines.push("Life plan: " + (plan.name || "Untitled") + " — " + money(result.monthlySurplusCents) + " monthly surplus");
    });
    return lines.join("\n");
  }

  function plannerMeta(item) {
    var life = normalizeItem(item);
    var plan = activePlan(life);
    var result = forecast(life, plan);
    if (!life.paths.length && !life.goals.length) return "Set up income paths and goals";
    var cash = result.monthlySurplusCents >= 0 ? money(result.monthlySurplusCents) + "/mo available" : money(Math.abs(result.monthlySurplusCents)) + "/mo short";
    return life.plans.length + " " + plural(life.plans.length, "plan") + " · " + cash;
  }

  ns.install = function (nextHost) {
    host = nextHost;
    return [{
      type: "life-planner",
      label: "Life Paths",
      menuLabel: "Life Paths",
      manageLabel: "Life Paths",
      manageHint: "Mix income paths, goals, and retirement scenarios",
      defaultEnabled: true,
      icon: ICON,
      placeholder: "My Life Paths",
      hideCopy: true,
      create: function () {
        var item = host.baseItem();
        item.type = "life-planner";
        item.title = "Life Paths";
        item.life = newLifeData();
        return item;
      },
      normalize: normalizeItem,
      text: plannerText,
      meta: plannerMeta,
      hasContent: function (item) {
        var life = normalizeItem(item);
        return !!(life.paths.length || life.goals.length || life.plans.length > 1 || item.title);
      },
      build: build
    }];
  };
})(window.SecondBrainLifePlanner = window.SecondBrainLifePlanner || {});
