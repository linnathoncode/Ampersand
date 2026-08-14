from pathlib import Path

import onnx
from onnx import TensorProto, helper


features = helper.make_tensor_value_info(
    "features",
    TensorProto.FLOAT,
    [1, 2],
)
prediction = helper.make_tensor_value_info(
    "prediction",
    TensorProto.FLOAT,
    [1, 1],
)

weights = helper.make_tensor(
    "weights",
    TensorProto.FLOAT,
    [2, 1],
    [2.0, 3.0],
)
bias = helper.make_tensor(
    "bias",
    TensorProto.FLOAT,
    [1],
    [5.0],
)

weighted = helper.make_node(
    "MatMul",
    ["features", "weights"],
    ["weighted"],
)
add_bias = helper.make_node(
    "Add",
    ["weighted", "bias"],
    ["prediction"],
)

graph = helper.make_graph(
    [weighted, add_bias],
    "ampersand-linear-regression-fixture",
    [features],
    [prediction],
    [weights, bias],
)
model = helper.make_model(
    graph,
    producer_name="ampersand-tests",
    opset_imports=[helper.make_opsetid("", 13)],
)

onnx.checker.check_model(model)
onnx.save(model, Path(__file__).with_name("linear-regression.onnx"))
