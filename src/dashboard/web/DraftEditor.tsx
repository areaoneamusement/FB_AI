import { useState, type FormEvent } from "react";
import type { ContentDraftDto } from "./api-client.js";

interface DraftEditorProps {
  readonly content: ContentDraftDto;
  readonly disabled: boolean;
  readonly onSave: (content: ContentDraftDto) => Promise<void>;
}

export function DraftEditor({ content, disabled, onSave }: DraftEditorProps) {
  const [draft, setDraft] = useState(() => structuredClone(content));
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  }

  function setVideo(field: keyof ContentDraftDto["videoScript"], value: string) {
    setDraft((current) => ({ ...current, videoScript: { ...current.videoScript, [field]: value } }));
  }

  return (
    <form className="panel editor" onSubmit={(event) => void submit(event)}>
      <div className="panel-heading">
        <div><p className="eyebrow">Active revision</p><h2>Draft content</h2></div>
        <button className="secondary" disabled={disabled || saving} type="submit">
          {saving ? "Saving…" : "Save as new revision"}
        </button>
      </div>
      <label>Facebook post<textarea maxLength={5000} rows={10} value={draft.facebookPost}
        onChange={(event) => setDraft({ ...draft, facebookPost: event.target.value })} /></label>

      <div className="two-column">
        <label>Language<input maxLength={5000} value={draft.language}
          onChange={(event) => setDraft({ ...draft, language: event.target.value })} /></label>
        <label>Brand voice version<input maxLength={5000} value={draft.brandVoiceVersion ?? ""}
          onChange={(event) => setDraft({ ...draft, brandVoiceVersion: event.target.value || undefined })} /></label>
      </div>

      <h3>Guide</h3>
      {draft.guide.map((section, index) => (
        <fieldset key={index}>
          <legend>Section {index + 1}</legend>
          <label>Heading<input maxLength={5000} value={section.heading} onChange={(event) => {
            const guide = draft.guide.map((item, itemIndex) => itemIndex === index ? { ...item, heading: event.target.value } : item);
            setDraft({ ...draft, guide });
          }} /></label>
          <label>Body<textarea maxLength={5000} rows={5} value={section.body} onChange={(event) => {
            const guide = draft.guide.map((item, itemIndex) => itemIndex === index ? { ...item, body: event.target.value } : item);
            setDraft({ ...draft, guide });
          }} /></label>
          {section.imageSuggestions.map((suggestion, suggestionIndex) => (
            <label key={suggestionIndex}>Image suggestion {suggestionIndex + 1}<input maxLength={5000}
              value={suggestion.description} onChange={(event) => {
                const images = section.imageSuggestions.map((item, imageIndex) =>
                  imageIndex === suggestionIndex ? { description: event.target.value } : item);
                const guide = draft.guide.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, imageSuggestions: images } : item);
                setDraft({ ...draft, guide });
              }} /></label>
          ))}
        </fieldset>
      ))}

      <h3>Video script</h3>
      <label>Intro<textarea maxLength={5000} rows={3} value={draft.videoScript.intro}
        onChange={(event) => setVideo("intro", event.target.value)} /></label>
      <label>Body<textarea maxLength={5000} rows={6} value={draft.videoScript.body}
        onChange={(event) => setVideo("body", event.target.value)} /></label>
      <label>Conclusion<textarea maxLength={5000} rows={3} value={draft.videoScript.conclusion}
        onChange={(event) => setVideo("conclusion", event.target.value)} /></label>

      <h3>Origin links</h3>
      {draft.originLinks.map((link, index) => (
        <label key={index}>Origin {index + 1}<input maxLength={5000} type="url" value={link}
          onChange={(event) => setDraft({
            ...draft,
            originLinks: draft.originLinks.map((item, itemIndex) => itemIndex === index ? event.target.value : item),
          })} /></label>
      ))}
      {disabled ? <p className="inline-notice">Editing is available only while this exact revision is pending approval.</p> : null}
    </form>
  );
}
