const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const appScript = scriptMatches[scriptMatches.length - 1][1];

assert(html.includes('id="progress-track"'), 'Answered progress bar is missing.');
assert(html.includes('id="review-button"'), 'Mark-for-review control is missing.');
assert(html.includes('id="question-navigator-dialog"'), 'Question navigator dialog is missing.');
assert(html.includes('id="finish-dialog"'), 'Custom finish confirmation dialog is missing.');
assert(html.includes('id="compact-navigator"'), 'Compact long-test navigator is missing.');
assert(!/<article class="test-card"[^>]*onclick=/i.test(html), 'Test cards should not use duplicate click handlers.');
assert(appScript.includes("input.type = isMultipleAnswer ? 'checkbox' : 'radio'"), 'Answer controls do not distinguish single and multiple answers.');
assert(appScript.includes('reviewedQuestions[currentIndex]'), 'Review state is not stored per question.');
assert(appScript.includes("quizScreen.classList.toggle('large-test', numQuestions >= 100)"), 'The 100-question compact navigator mode is not enabled.');
assert(appScript.includes("document.addEventListener('keydown', handleQuizKeyboard)"), 'Keyboard navigation is not registered.');
assert(!appScript.includes("if (confirm(t('confirmFinish')))"), 'Legacy browser finish confirmation remains.');

console.log('All interface checks passed.');
