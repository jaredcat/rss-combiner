---
name: Deployment Issue
about: Report problems with GitHub Actions deployment
title: '[DEPLOY] '
labels: ['deployment', 'help wanted']
assignees: ''

---

## Deployment Issue

**Deployment Method:**

- [ ] GitHub Actions (recommended)
- [ ] Local development

**Problem Description:**
<!-- Describe what went wrong -->

**GitHub Actions Workflow Run:**
<!-- If using GitHub Actions, please provide a link to the failed workflow run -->
Link:

**Configuration:**

```toml
# Please share your wrangler.toml configuration (remove any sensitive information)
name = "your-worker-name"
bucket_name = "your-bucket-name"

[vars]
FEED_TITLE = "Your Feed Title"
# List your feeds (you can use example URLs if needed)
FEED_01_URL = "https://example.com/feed1"
```

**Error Messages:**
<!-- Copy and paste any error messages from the GitHub Actions logs or local terminal -->
```
Paste error messages here
```

**Steps Taken:**
<!-- What steps did you follow? -->
1.
2.
3.

**Expected Behavior:**
<!-- What should have happened? -->

**Additional Context:**
<!-- Add any other context about the problem here -->

---

**For GitHub Actions issues, please:**

1. Go to the **Actions** tab in your repository
2. Click on the failed workflow run
3. Copy the error messages from the failing step
4. Include the link to the workflow run above
