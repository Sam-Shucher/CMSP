import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultiImagePicker from './MultiImagePicker';

function makeFile(name: string): File {
  return new File(['contents'], name, { type: 'image/png' });
}

describe('MultiImagePicker', () => {
  it('shows a thumbnail for each existing image and lets you remove one', () => {
    const onChange = vi.fn();
    render(
      <MultiImagePicker
        existingPaths={['/uploads/a.png', '/uploads/b.png']}
        onChange={onChange}
      />
    );

    expect(screen.getAllByRole('img')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(onChange).toHaveBeenCalledWith(['/uploads/b.png'], []);
  });

  it('shows an add dropzone while under the 3-image cap, and adds a dropped file', () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={['/uploads/a.png']} onChange={onChange} />);

    const zone = screen.getByTestId('image-dropzone');
    const file = makeFile('new.png');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(onChange).toHaveBeenCalledWith(['/uploads/a.png'], [file]);
  });

  it('hides the add dropzone once 3 images are already selected', () => {
    render(
      <MultiImagePicker
        existingPaths={['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId('image-dropzone')).not.toBeInTheDocument();
    expect(screen.getByText(/3 of 3/i)).toBeInTheDocument();
  });

  it('starts empty when no existingPaths are given (create mode)', () => {
    render(<MultiImagePicker existingPaths={[]} onChange={vi.fn()} />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByTestId('image-dropzone')).toBeInTheDocument();
  });
});
