# X-block AI

Chrome extension for reducing porn/spam comments on X.com.

It combines manual blocking, local learning, local rules, and optional LLM review. The goal is to block obvious spam quickly while reducing false positives through correction samples and periodic rule distillation.

## Features

- Adds a `屏蔽并学习` button to X.com comments.
- Records blocked accounts in a local account database.
- Learns from manual blocks with a local Naive Bayes model.
- Uses nickname, username, comment text, and mentioned accounts as signals.
- Calls an LLM only for uncertain or borderline cases when configured.
- Periodically distills local samples into compact AI rules.
- Supports false-positive correction through `恢复`.
- Can release likely false-positive accounts during AI rule analysis, while protecting manually blocked or repeatedly blocked accounts.
- Exports/imports the local database as JSON.

## Install

1. Open Chrome and go to `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.

After code changes, click `Reload` on the extension card and refresh X.com.

## How It Works

The classifier runs in this order:

1. Account database
   - If an account is already blocked locally, its comments are masked.
2. Local rules
   - Strong adult/spam signals can be handled locally.
   - Weaker marketing, nickname, or mention-based signals are treated as suspicious and usually sent to LLM review.
3. Local Bayes model
   - Learns from manual blocks, LLM labels, and correction samples.
4. LLM review
   - Used for borderline or suspicious cases when API settings are configured.
   - LLM results are written back as weighted samples.
5. AI rule distillation
   - The popup button `AI分析规则` asks the LLM to summarize local samples into compact rules.

## Signals Used

The extension considers:

- Comment text
- Display name / nickname
- Username / handle
- Mentioned accounts in the comment

Mentioned accounts are weighted signals only. The extension attempts to exclude:

- The original poster
- Other visible normal commenters

## Manual Actions

### 屏蔽并学习

Manual block is a high-confidence spam signal.

It will:

- Add the account to the local block database.
- Train the local model as spam.
- Record a high-weight sample.
- Optionally trigger X.com's native block flow.
- Add suspicious mentioned accounts to the local database when appropriate.

### 恢复

`恢复` means the current item was likely a false positive.

It will:

- Reveal the comment.
- Train the local model as ham.
- Record a high-weight correction sample.
- Remove the account from the local blocked list.

### 恢复后再隐藏

If you restore a comment and then decide it really should be blocked, clicking `隐藏` again records a stronger spam correction.

This protects against accidental restores.

## AI Analysis Rules

Click `AI分析规则` in the popup to ask the configured LLM to analyze local samples.

It can:

- Generate compact local rules.
- Suggest releasing likely false-positive accounts.
- Preserve high-confidence blocked accounts.

Accounts are protected from automatic release if:

- They were manually blocked.
- They were manually confirmed after restore.
- They were blocked more than 5 times.

The analysis has timeout/error handling. If it fails, the popup should show the reason.

## Data View

The popup includes `查看本地数据`.

It shows:

- Recent blocked accounts
- Recent spam samples
- Recent normal/correction samples
- Current AI rules

For full data, use `导出`.

## Local Data Format

Exported JSON may include:

- `accounts`: local account database
- `samples`: weighted raw samples
- `aiRules`: distilled AI rules
- `bayes`: local Naive Bayes feature counts

Sample labels:

- `spam`: should be blocked
- `ham`: normal or false-positive correction

Common sample sources:

- `manual`: user clicked `屏蔽并学习`
- `manual-confirm`: restored and then hidden again
- `restore`: user clicked `恢复`
- `llm`: LLM classification
- `bayes`: local Bayes classification
- `heuristic`: local rule classification
- `ai-release`: released by AI rule analysis

## LLM Configuration

The popup supports common OpenAI-compatible providers:

- DeepSeek
- OpenAI
- OpenRouter
- Groq
- SiliconFlow
- Zhipu GLM
- Custom endpoint

Required fields:

- Endpoint
- API Key
- Model

The extension uses standard chat-completions style requests.

## Recommended Settings

- Keep `本地贝叶斯自动屏蔽阈值` relatively high.
- Keep `边界复核范围` around `0.08` to `0.15`.
- If false positives are high, increase the Bayes threshold or reduce the review range.
- Use `恢复` whenever a normal comment is masked, so the model learns.

## Privacy

Data is stored in `chrome.storage.local`.

When LLM is enabled, uncertain comments and local samples used for `AI分析规则` are sent to the configured API provider. Do not configure an API provider you do not trust.

## Development

Syntax check:

```bash
node --check content.js
node --check background.js
node --check popup.js
```

Push changes:

```bash
git add .
git commit -m "your message"
git push origin main
```
