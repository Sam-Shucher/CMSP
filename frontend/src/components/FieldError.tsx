import React from 'react';

// The message under a form field. Its id matches the input's aria-describedby
// (see useValidatedForm), so screen readers read it with the field.
export default function FieldError({ id, message }: { id: string; message: string | null }): React.ReactElement {
  return (
    <p id={`${id}-error`} role={message ? 'alert' : undefined} className="field-error" hidden={!message}>
      {message}
    </p>
  );
}
