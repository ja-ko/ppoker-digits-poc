# Third-party model notice

The CRNN Tiny architecture in `model.py` and the initial weights used to produce
the distributed ONNX model are adapted from
[`zjykzj/crnn-ctc`](https://github.com/zjykzj/crnn-ctc) release `v1.3.0`, commit
`aeceea3a2ab7e973b40d871ff628b327df31a045`, by zjykzj. The upstream work is
licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
and is copyright 2023 zjykzj.

The local derivative changes the input width from 160 to 128, composes canonical
one-to-three-digit labels, fine-tunes the published `crnn_tiny-emnist.pth`
weights, and exports a static batch-one ONNX graph. No upstream source files or
unmodified checkpoint are redistributed.

Training glyphs come from EMNIST Digits, derived from NIST Special Database 19:
G. Cohen, S. Afshar, J. Tapson, and A. van Schaik, "EMNIST: an extension of
MNIST to handwritten letters," 2017, <https://arxiv.org/abs/1702.05373>.
