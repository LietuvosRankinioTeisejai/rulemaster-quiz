const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const appScript = scriptMatches[scriptMatches.length - 1][1];
const formerRequiredRules = [2, 4, 6, 7, 8, 13, 14, 15, 16];
const THIRTY_ATTEMPTS = 600;

function createSeededCrypto(seed) {
  let state = seed >>> 0;
  return {
    getRandomValues(values) {
      for (let index = 0; index < values.length; index += 1) {
        state = ((state * 1664525) + 1013904223) >>> 0;
        values[index] = state;
      }
      return values;
    }
  };
}

function makeContext(seed = 0x13579bdf) {
  const noop = () => {};
  const makeClassList = () => ({ add: noop, remove: noop, toggle: noop, contains: () => true });
  const makeElement = () => ({
    classList: makeClassList(),
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    appendChild: noop,
    scrollIntoView: noop
  });
  const context = {
    console,
    crypto: createSeededCrypto(seed),
    localStorage: { getItem: () => 'en', setItem: noop },
    document: {
      documentElement: {},
      getElementById: makeElement,
      createElement: makeElement,
      addEventListener: noop,
      hidden: false
    },
    window: { addEventListener: noop, scrollTo: noop, print: noop },
    fetch: async () => ({ ok: false }),
    alert: noop,
    confirm: () => true,
    setInterval,
    clearInterval,
    setTimeout,
    Date
  };
  vm.createContext(context);
  vm.runInContext(appScript, context);
  return context;
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

function setQuestionBank(context, bank) {
  context.__QUESTION_BANK__ = bank;
  evaluate(context, 'questionBank = __QUESTION_BANK__');
}

function auditThirty(context) {
  return JSON.parse(evaluate(context, `JSON.stringify((() => {
    const audit = buildThirtyQuestionSet();
    const categoryCounts = {};
    const questionKeysByCategory = {};
    audit.questions.forEach(question => {
      const category = getQuestionCategory(question);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      if (!questionKeysByCategory[category]) questionKeysByCategory[category] = [];
      questionKeysByCategory[category].push(getQuestionKey(question));
    });
    const ruleCodesByCategory = {};
    audit.questions.forEach(question => {
      const category = getQuestionCategory(question);
      if (!ruleCodesByCategory[category]) ruleCodesByCategory[category] = [];
      ruleCodesByCategory[category].push(getRuleCode(question));
    });
    const numberedRules = Object.keys(categoryCounts)
      .filter(category => category.startsWith('RULE_'))
      .map(category => Number(category.slice(5)))
      .sort((a, b) => a - b);
    return {
      total: audit.questions.length,
      categoryCap: audit.categoryCap,
      categoryCounts,
      questionKeysByCategory,
      ruleCodesByCategory,
      keys: audit.questions.map(getQuestionKey),
      numberedRules,
      sarCount: audit.questions.filter(isSarQuestion).length,
      difficult: audit.questions.filter(question => isDifficultOrLong(question, audit.difficultyThreshold)).length,
      scenario: audit.questions.filter(isScenarioBased).length,
      multipleAnswer: audit.questions.filter(question => Array.isArray(question.correct) && question.correct.length > 1).length,
      averageComplexity: audit.questions.reduce((sum, question) => sum + getQuestionComplexityScore(question), 0) / audit.questions.length
    };
  })())`));
}

function auditHundred(context) {
  return JSON.parse(evaluate(context, `JSON.stringify((() => {
    const audit = buildExtremeQuestionSet();
    const categoryCounts = {};
    audit.questions.forEach(question => {
      const category = getQuestionCategory(question);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });
    return {
      total: audit.questions.length,
      difficult: audit.questions.filter(q => isDifficultOrLong(q, audit.difficultyThreshold)).length,
      sarCount: audit.questions.filter(isSarQuestion).length,
      categoryCap: audit.categoryCap,
      categoryCounts,
      keys: audit.questions.map(getQuestionKey)
    };
  })())`));
}

function auditUltramarathon(context) {
  return JSON.parse(evaluate(context, `JSON.stringify((() => {
    const bank = getUniqueQuestionPool(questionBank);
    const questions = selectQuestionsForTest(bank.length, ULTRAMARATHON_MODE);
    return {
      expectedTotal: bank.length,
      total: questions.length,
      expectedKeys: bank.map(getQuestionKey).sort(),
      selectedKeys: questions.map(getQuestionKey).sort(),
      order: questions.map(getQuestionKey)
    };
  })())`));
}

function testStandardModes(context) {
  for (const count of [15, 20]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const audit = JSON.parse(evaluate(context, `JSON.stringify((() => {
        const questions = selectQuestionsForTest(${count});
        return { total: questions.length, keys: questions.map(getQuestionKey) };
      })())`));
      assert.strictEqual(audit.total, count, `${count}-question mode returned the wrong number of questions.`);
      assert.strictEqual(new Set(audit.keys).size, count, `${count}-question mode contains duplicate questions.`);
    }
  }
}

function testThirtyCapFailure(context, bank) {
  context.__LIMITED_BANK__ = bank;
  evaluate(context, `questionBank = __LIMITED_BANK__.filter(question => {
    const rule = getRuleNumber(question);
    return rule !== null && rule >= 1 && rule <= 9;
  })`);
  const limitedUniqueCount = evaluate(context, 'getUniqueQuestionPool(questionBank).length');
  assert(limitedUniqueCount >= 30, 'The cap-failure fixture must contain at least 30 unique raw questions.');
  assert.throws(
    () => evaluate(context, 'buildThirtyQuestionSet()'),
    /hard .*limit|cannot produce/i,
    'The 30-question generator relaxed the category cap instead of failing clearly.'
  );
  setQuestionBank(context, bank);
}

function testAnswerShuffling(context, bank) {
  const source = bank.find(question => Array.isArray(question.correct) && question.correct.length > 1 && question.options.length >= 4);
  assert(source, 'A multiple-answer question is required for this test.');
  context.__SOURCE_QUESTION__ = source;

  const audit = JSON.parse(evaluate(context, `JSON.stringify((() => {
    const original = __SOURCE_QUESTION__;
    const before = JSON.stringify(original);
    const shuffled = shuffleQuestionAnswers(original);
    return { before, afterOriginal: JSON.stringify(original), isClone: shuffled !== original, shuffled };
  })())`));

  assert.strictEqual(audit.before, audit.afterOriginal, 'The original question was mutated.');
  assert(audit.isClone, 'The shuffled question must be a clone.');
  assert.deepStrictEqual(
    [...audit.shuffled.options].sort(),
    source.options.map(option => option.replace(/^\s*[a-z]\)\s*/i, '')).sort(),
    'Shuffled options are not a permutation of the original options.'
  );

  const expectedCorrectTexts = source.correct
    .map(index => source.options[index].replace(/^\s*[a-z]\)\s*/i, ''))
    .sort();
  const actualCorrectTexts = audit.shuffled.correct
    .map(index => audit.shuffled.options[index])
    .sort();
  assert.deepStrictEqual(actualCorrectTexts, expectedCorrectTexts, 'Correct indexes were not remapped accurately.');

  const answerOrders = new Set();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    answerOrders.add(evaluate(context, 'shuffleQuestionAnswers(__SOURCE_QUESTION__).options.join("||")'));
  }
  assert(answerOrders.size > 1, 'Answer choices did not vary across attempts.');
}

function runBankTests(filename) {
  const bank = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const originalBankSnapshot = JSON.stringify(bank);
  const context = makeContext(filename.includes('-en') ? 0x13579bdf : 0x2468ace0);
  setQuestionBank(context, bank);

  const sourceCountsByCategory = JSON.parse(evaluate(context, `JSON.stringify((() => {
    const counts = {};
    getUniqueQuestionPool(questionBank).filter(isEligibleForThirtyQuestionTest).forEach(question => {
      const category = getQuestionCategory(question);
      counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  })())`));

  const selectionSignatures = new Set();
  const orderSignatures = new Set();
  const ruleCombinationSignatures = new Set();
  const ruleDistributionSignatures = new Set();
  const sarCounts = new Set();
  const specialRuleCounts = { 1: new Set(), 3: new Set() };
  const seenQuestionKeysByCategory = new Map();
  const formerRuleWasMissing = Object.fromEntries(formerRequiredRules.map(rule => [rule, false]));
  let minCategoryCount = Infinity;
  let maxCategoryCount = 0;
  let previousThirtyKeys = null;
  let previousRuleCombinationSignature = null;
  let previousRuleDistributionSignature = null;
  let totalConsecutiveQuestionOverlap = 0;
  let maxConsecutiveQuestionOverlap = 0;
  let consecutiveRuleCombinationRepeats = 0;
  let consecutiveRuleDistributionRepeats = 0;
  let difficultTotal = 0;
  let difficultMin = Infinity;
  let difficultMax = 0;
  let scenarioTotal = 0;
  let multipleAnswerTotal = 0;
  let complexityTotal = 0;

  for (let attempt = 0; attempt < THIRTY_ATTEMPTS; attempt += 1) {
    const audit = auditThirty(context);
    const counts = Object.values(audit.categoryCounts);
    const categories = Object.keys(audit.categoryCounts).sort();

    assert.strictEqual(audit.total, 30, 'The 30-question test returned the wrong number of questions.');
    assert.strictEqual(audit.keys.length, 30);
    assert.strictEqual(new Set(audit.keys).size, 30, 'The 30-question test contains duplicate questions.');
    assert.strictEqual(audit.categoryCap, 3, 'The general 30-question category cap is not 3.');
    assert(Math.max(...counts) <= 3, 'A top-level rule/category exceeded the hard maximum of 3.');
    assert((audit.categoryCounts.RULE_1 || 0) <= 1, 'Rule 1 exceeded its hard maximum of 1 question.');
    assert((audit.categoryCounts.RULE_3 || 0) <= 1, 'Rule 3 exceeded its hard maximum of 1 question.');
    assert((audit.ruleCodesByCategory.RULE_1 || []).every(code => code === '1.4'), 'A Rule 1 question other than Rule 1.4 appeared in the 30-question test.');
    assert((audit.ruleCodesByCategory.RULE_3 || []).every(code => code === '3.4'), 'A Rule 3 question other than Rule 3.4 appeared in the 30-question test.');

    minCategoryCount = Math.min(minCategoryCount, categories.length);
    maxCategoryCount = Math.max(maxCategoryCount, categories.length);
    const selectionSignature = [...audit.keys].sort().join('\n');
    const orderSignature = audit.keys.join('\n');
    const ruleCombinationSignature = audit.numberedRules.join(',');
    const ruleDistributionSignature = categories.map(category => `${category}:${audit.categoryCounts[category]}`).join('|');

    if (previousThirtyKeys) {
      const overlap = audit.keys.filter(key => previousThirtyKeys.has(key)).length;
      totalConsecutiveQuestionOverlap += overlap;
      maxConsecutiveQuestionOverlap = Math.max(maxConsecutiveQuestionOverlap, overlap);
      if (ruleCombinationSignature === previousRuleCombinationSignature) consecutiveRuleCombinationRepeats += 1;
      if (ruleDistributionSignature === previousRuleDistributionSignature) consecutiveRuleDistributionRepeats += 1;
    }
    previousThirtyKeys = new Set(audit.keys);
    previousRuleCombinationSignature = ruleCombinationSignature;
    previousRuleDistributionSignature = ruleDistributionSignature;

    selectionSignatures.add(selectionSignature);
    orderSignatures.add(orderSignature);
    ruleCombinationSignatures.add(ruleCombinationSignature);
    ruleDistributionSignatures.add(ruleDistributionSignature);
    sarCounts.add(audit.sarCount);
    specialRuleCounts[1].add(audit.categoryCounts.RULE_1 || 0);
    specialRuleCounts[3].add(audit.categoryCounts.RULE_3 || 0);
    difficultTotal += audit.difficult;
    difficultMin = Math.min(difficultMin, audit.difficult);
    difficultMax = Math.max(difficultMax, audit.difficult);
    scenarioTotal += audit.scenario;
    multipleAnswerTotal += audit.multipleAnswer;
    complexityTotal += audit.averageComplexity;

    formerRequiredRules.forEach(rule => {
      if (!audit.numberedRules.includes(rule)) formerRuleWasMissing[rule] = true;
    });

    Object.entries(audit.questionKeysByCategory).forEach(([category, keys]) => {
      if (!seenQuestionKeysByCategory.has(category)) seenQuestionKeysByCategory.set(category, new Set());
      keys.forEach(key => seenQuestionKeysByCategory.get(category).add(key));
    });
  }

  assert.strictEqual(selectionSignatures.size, THIRTY_ATTEMPTS, 'A full 30-question selection repeated during the long consecutive stress run.');
  assert.strictEqual(orderSignatures.size, THIRTY_ATTEMPTS, 'A final 30-question order repeated during the long consecutive stress run.');
  assert(ruleCombinationSignatures.size >= Math.floor(THIRTY_ATTEMPTS * 0.4), 'Too few distinct numbered-rule combinations were generated.');
  assert(ruleDistributionSignatures.size >= Math.floor(THIRTY_ATTEMPTS * 0.95), 'Too few distinct rule/category distributions were generated.');
  assert(minCategoryCount >= 10, 'A 30-question test used too few rule/category families to respect the cap of 3.');
  assert(maxCategoryCount > minCategoryCount, 'The number of represented rule/category families never changes.');

  const averageConsecutiveQuestionOverlap = totalConsecutiveQuestionOverlap / Math.max(1, THIRTY_ATTEMPTS - 1);
  assert(maxConsecutiveQuestionOverlap <= 5, 'Consecutive 30-question tests repeated too many exact questions.');
  assert(averageConsecutiveQuestionOverlap <= 1.25, 'Consecutive 30-question tests repeat too much of the immediately previous test on average.');
  assert(consecutiveRuleCombinationRepeats <= Math.ceil(THIRTY_ATTEMPTS * 0.04), 'Consecutive 30-question tests repeat the same numbered-rule combination too often.');
  assert(consecutiveRuleDistributionRepeats <= Math.ceil(THIRTY_ATTEMPTS * 0.01), 'Consecutive 30-question tests repeat the same full rule distribution too often.');

  formerRequiredRules.forEach(rule => {
    assert(formerRuleWasMissing[rule], `Former required Rule ${rule} still appeared mandatory across all generated tests.`);
  });

  assert(sarCounts.has(0), 'SAR questions became mandatory in the 30-question test.');
  assert([...sarCounts].some(count => count > 0), 'SAR questions never participated in the 30-question test.');
  assert(Math.max(...sarCounts) <= 3, 'SAR exceeded the same hard category cap of 3.');

  for (const rule of [1, 3]) {
    assert(specialRuleCounts[rule].has(0), `Rule ${rule} became mandatory in the 30-question test.`);
    assert(specialRuleCounts[rule].has(1), `Rule ${rule} never appeared in the 30-question test.`);
    assert(![...specialRuleCounts[rule]].some(count => count > 1), `Rule ${rule} exceeded its hard maximum of 1.`);
  }

  const averageDifficult = difficultTotal / THIRTY_ATTEMPTS;
  const averageScenario = scenarioTotal / THIRTY_ATTEMPTS;
  const averageMultipleAnswer = multipleAnswerTotal / THIRTY_ATTEMPTS;
  assert(difficultMin >= 18, 'The strengthened 30-question mode produced a test with too few difficult/long questions.');
  assert(averageDifficult >= 22, 'The strengthened 30-question mode is not challenging enough on average.');
  assert(averageScenario >= 21, 'Scenario-based questions are not represented strongly enough in the challenge mix.');
  assert(averageMultipleAnswer >= 12, 'Multiple-answer questions are not represented strongly enough in the challenge mix.');

  Object.entries(sourceCountsByCategory).forEach(([category, sourceCount]) => {
    if (!category.startsWith('RULE_') || sourceCount < 4) return;
    const seenCount = seenQuestionKeysByCategory.get(category)?.size || 0;
    assert(
      seenCount >= Math.min(sourceCount, 6),
      `${category} did not vary the selected questions enough across repeated 30-question tests.`
    );
  });

  const eligibleQuestionCount = Object.values(sourceCountsByCategory).reduce((sum, count) => sum + count, 0);
  const seenEligibleQuestionCount = [...seenQuestionKeysByCategory.values()].reduce((sum, keys) => sum + keys.size, 0);
  assert(
    seenEligibleQuestionCount >= Math.floor(eligibleQuestionCount * 0.9),
    'The long stress run did not rotate through enough of the eligible 30-question pool.'
  );

  testThirtyCapFailure(context, bank);
  testStandardModes(context);

  const hundredSelections = new Set();
  const hundredOrders = new Set();
  const hundredSarCounts = new Set();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const audit = auditHundred(context);
    assert.strictEqual(audit.total, 100);
    assert.strictEqual(new Set(audit.keys).size, 100);
    assert(audit.difficult >= 70);
    assert(Math.max(...Object.values(audit.categoryCounts)) <= audit.categoryCap);
    hundredSelections.add([...audit.keys].sort().join('\n'));
    hundredOrders.add(audit.keys.join('\n'));
    hundredSarCounts.add(audit.sarCount);
  }

  assert(hundredSelections.size > 1, 'The 100-question selection did not vary.');
  assert(hundredOrders.size > 1, 'The 100-question order did not vary.');
  assert(hundredSarCounts.size > 1, 'The 100-question test always selected the same SAR count.');
  assert(Math.max(...hundredSarCounts) < 10, 'SAR questions dominate the 100-question test.');

  const ultramarathonOrders = new Set();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const audit = auditUltramarathon(context);
    assert.strictEqual(audit.total, audit.expectedTotal, 'Ultramarathon did not select the full unique bank.');
    assert.strictEqual(new Set(audit.selectedKeys).size, audit.expectedTotal, 'Ultramarathon contains duplicate questions.');
    assert.deepStrictEqual(audit.selectedKeys, audit.expectedKeys, 'Ultramarathon omitted or added questions.');
    ultramarathonOrders.add(audit.order.join('\n'));
  }
  assert(ultramarathonOrders.size > 1, 'Ultramarathon order did not vary across attempts.');

  testAnswerShuffling(context, bank);
  assert.strictEqual(JSON.stringify(bank), originalBankSnapshot, 'Question-bank objects were mutated by randomization tests.');

  return {
    filename,
    thirtyAttempts: THIRTY_ATTEMPTS,
    thirtyUniqueSelections: selectionSignatures.size,
    thirtyUniqueOrders: orderSignatures.size,
    thirtyRuleCombinations: ruleCombinationSignatures.size,
    thirtyRuleDistributions: ruleDistributionSignatures.size,
    thirtyCategoryCountRange: [minCategoryCount, maxCategoryCount],
    thirtyAverageConsecutiveQuestionOverlap: Number((totalConsecutiveQuestionOverlap / Math.max(1, THIRTY_ATTEMPTS - 1)).toFixed(2)),
    thirtyMaxConsecutiveQuestionOverlap: maxConsecutiveQuestionOverlap,
    thirtyConsecutiveRuleCombinationRepeats: consecutiveRuleCombinationRepeats,
    thirtyConsecutiveRuleDistributionRepeats: consecutiveRuleDistributionRepeats,
    thirtySarCounts: [...sarCounts].sort((a, b) => a - b),
    thirtyRule1Counts: [...specialRuleCounts[1]].sort((a, b) => a - b),
    thirtyRule3Counts: [...specialRuleCounts[3]].sort((a, b) => a - b),
    thirtyDifficultRange: [difficultMin, difficultMax],
    thirtyAverageDifficult: Number((difficultTotal / THIRTY_ATTEMPTS).toFixed(2)),
    thirtyAverageScenario: Number((scenarioTotal / THIRTY_ATTEMPTS).toFixed(2)),
    thirtyAverageMultipleAnswer: Number((multipleAnswerTotal / THIRTY_ATTEMPTS).toFixed(2)),
    thirtyAverageComplexity: Number((complexityTotal / THIRTY_ATTEMPTS).toFixed(2)),
    thirtyEligibleQuestionCoverage: `${seenEligibleQuestionCount}/${eligibleQuestionCount}`,
    hundredUniqueSelections: hundredSelections.size,
    hundredUniqueOrders: hundredOrders.size,
    hundredSarCounts: [...hundredSarCounts].sort((a, b) => a - b),
    ultramarathonUniqueOrders: ultramarathonOrders.size
  };
}

assert(!appScript.includes('.sort(() => Math.random() - 0.5)'), 'Prohibited random sort remains in the app.');
assert(!appScript.includes('REQUIRED_RULES_30'), 'Legacy fixed required-rule behavior remains in the app.');
assert(!appScript.includes('THIRTY_MIN_DIFFICULT_ADDITIONAL'), 'Legacy hard difficult-question quota remains in the app.');
assert(!appScript.includes('THIRTY_ADDITIONAL_COUNT'), 'Legacy required/additional split remains in the app.');
assert(appScript.includes("THIRTY_RULE_ONLY_CODES = new Map([[1, '1.4'], [3, '3.4']])"), 'Rule 1.4/3.4 eligibility configuration is missing.');
assert(appScript.includes('isEligibleForThirtyQuestionTest'), '30-question Rule 1.4/3.4 eligibility helper is missing.');
assert(appScript.includes('getThirtyQuestionCategoryLimit'), '30-question category-specific cap helper is missing.');
assert(appScript.includes('THIRTY_HISTORY_DEPTH = 12'), 'Deep 30-question recent-history rotation is missing.');
assert(appScript.includes('THIRTY_HARD_BIAS_MIN = 4.2'), 'Stronger randomized difficulty bias is missing.');
assert(appScript.includes('getThirtyQuestionCandidatePool'), 'Recent-question exclusion helper is missing.');
assert(appScript.includes('thirtyQuestionUsageCounts'), 'Long-sequence question usage tracking is missing.');
assert(appScript.includes('desiredHardMinimum'), 'Randomized difficult-question target is missing.');
assert(appScript.includes('selectThirtyBucketQuestions'), '30-question recency-aware question selection is missing.');
assert(appScript.includes('rememberThirtyQuestionSet'), '30-question recent-set memory is missing.');
assert(!appScript.includes('shuffledOptions'), 'Legacy answer-order storage remains in the app.');
assert(appScript.includes('q.options.map((raw, optionIndex)'), 'Detailed reports must use the attempt-specific option order.');

const results = [runBankTests('questions-en.json'), runBankTests('questions-lt.json')];
console.log(JSON.stringify(results, null, 2));
console.log('All randomisation tests passed.');
