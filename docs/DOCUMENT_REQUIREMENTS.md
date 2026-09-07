# Document uploads, requirements and test drafts

## Workflow

1. Open **Projects → project → Requirements → Upload document**.
2. Upload PDF, Word `.docx`, UTF-8/UTF-16 text, or Markdown. The source text is extracted locally and saved. No model is called during upload.
3. Review the text sections. Edit titles and acceptance criteria, deselect sections that are not requirements, and inspect each exact source excerpt. Optionally choose **Extract with AI** before importing any requirements from this document.
4. **Save selected requirements** creates draft requirements in the current project. Approval remains a separate action in Requirement details.
5. **Create test draft** beside a requirement opens an environment selector and editable preconditions, tester actions and expected results. Saving creates and links one test draft, then opens its editor.
6. Expand **Test design · actions & expected results** to edit the design. Record or add real automation steps before running. The generated draft has no executable steps, so it cannot report a successful run merely because a document was imported. Additional test cases can be linked in Requirement details.

Test designs are preserved by save and JSON export/import. They describe manual actions but do not create a manual execution verdict or invent browser selectors. Existing generated drafts can be opened through the requirement's test link. Retrying draft creation returns the same file.

## Source handling and limits

- Up to 3 MB per file, 40 PDF pages, and 60,000 extracted characters. Legacy `.doc`, macro-enabled documents, images and scanned PDFs without text are unsupported; perform OCR first. Tables and layout become plain text and require review.
- Parsing uses a child process with a 20-second deadline, a 192 MB JavaScript heap limit and at most two simultaneous readers. These bounds are resource controls, not an OS security sandbox. PDF script evaluation is disabled; DOCX uses raw-text extraction with external file access disabled by default.
- Original files are not retained. Extracted text, source hash, filename, uploader, revision and candidate designs are stored under `ui/data/documents/<projectId>/`. Back up this directory with the other workspace data. Uploading the same bytes to the same project reopens the existing document.
- Up to 100 source documents and 1,000 requirements per project. Import accepts up to 30 candidates at once. Requirements are saved in one atomic replacement of the requirements store. Repeated imports of an existing candidate do not duplicate it.
- Each imported requirement retains its document ID, candidate ID and exact source quote. Removing a document's saved source text keeps imported requirements, excerpts and tests. Deleting a test removes its requirement link while retaining source provenance.
- Documents and requirements are shared with authenticated workspace members, matching the existing project model. Test cases retain their own sharing permissions. Document mutation requires `folders.manage`; creating linked drafts also requires `tests.create`. AI additionally requires `ai.analyze`.
- Revisions protect document generation/import and requirement edits against stale writes. Test creation rolls back its newly written file and metadata on synchronous save errors; the stores do not provide a distributed or crash-atomic database transaction.

## Optional AI and telemetry

**Extract with AI** sends extracted text to the configured Anthropic-compatible provider. It supports documents up to 24,000 characters and requests up to 20 requirements with test designs. The response must cite exact, contiguous source passages and satisfy bounded schema validation. Invalid responses leave the saved document draft unchanged. Source matching does not prove the model's interpretation is correct; a tester must review it.

Document text is treated as untrusted source material. It cannot change the extractor's role, output contract or tool access. No document content is executed.

Provider-reported usage is attributed to the initiating user and `document-requirements` in **Settings → AI telemetry**. Rejected model drafts still incur and record provider usage. The existing daily token guard applies; in-flight calls may exceed the cap. Telemetry does not expose document text. Without a provider key, local extraction, requirement review and test draft creation remain available.

## Verification

Parser tests read actual in-memory PDF and DOCX files plus Markdown and UTF-16 text. They reject invalid files, blank PDFs, page/size limits, forged source passages, duplicate candidates and invalid test designs. An isolated local provider verifies AI generation, rejected quotes, revision conflicts, project scoping and token attribution without paid calls.

The Studio browser journey covers upload, editing source-derived requirements, duplicate imports, permissions, test creation, saved design edits, JSON round trips, non-runnable drafts and source retention after removal. Desktop/mobile screenshots are inspected. Account management and password tests access their controls through Settings.
