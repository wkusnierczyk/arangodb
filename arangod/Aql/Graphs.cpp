////////////////////////////////////////////////////////////////////////////////
/// DISCLAIMER
///
/// Copyright 2014-2016 ArangoDB GmbH, Cologne, Germany
/// Copyright 2004-2014 triAGENS GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is ArangoDB GmbH, Cologne, Germany
///
/// @author Michael Hackstein
////////////////////////////////////////////////////////////////////////////////

#include "Graphs.h"
#include "Aql/AstNode.h"
#include "Basics/VelocyPackHelper.h"

#include <velocypack/Iterator.h>
#include <velocypack/velocypack-aliases.h>

using namespace arangodb::basics;
using namespace arangodb::aql;

char const* Graph::_attrEdgeDefs = "edgeDefinitions";
char const* Graph::_attrOrphans = "orphanCollections";

EdgeConditionBuilder::EdgeConditionBuilder(AstNode* modCondition)
    : _fromCondition(nullptr),
      _toCondition(nullptr),
      _modCondition(modCondition),
      _containsCondition(false) {
  TRI_ASSERT(_modCondition->type == NODE_TYPE_OPERATOR_NARY_AND);
}

void EdgeConditionBuilder::addConditionPart(AstNode const* part) {
  TRI_ASSERT(!_containsCondition);
  // The ordering is only maintained before we request a specific
  // condition
  _modCondition->addMember(part);
}

void EdgeConditionBuilder::swapSides(AstNode* cond) {
  TRI_ASSERT(cond != nullptr);
  TRI_ASSERT(cond == _fromCondition || cond == _toCondition);
  TRI_ASSERT(cond->type == NODE_TYPE_OPERATOR_BINARY_EQ);
  if (_containsCondition) {
#ifdef TRI_ENABLE_MAINTAINER_MODE
    // If used correctly this class guarantuees that the last element
    // of the nary-and is the _from or _to part and is exchangable.
    TRI_ASSERT(_modCondition->numMembers() > 0);
    auto changeNode =
        _modCondition->getMemberUnchecked(_modCondition->numMembers() - 1);
    TRI_ASSERT(changeNode == _fromCondition || changeNode == _toCondition);
#endif
    _modCondition->changeMember(_modCondition->numMembers() - 1,
                                cond);
  } else {
    _modCondition->addMember(cond);
    _containsCondition = true;
  }
  TRI_ASSERT(_modCondition->numMembers() > 0);
}

AstNode const* EdgeConditionBuilder::getOutboundCondition() {
  if (_fromCondition == nullptr) {
    buildFromCondition();
  }
  TRI_ASSERT(_fromCondition != nullptr);
  swapSides(_fromCondition);
  return _modCondition;
}

AstNode const* EdgeConditionBuilder::getInboundCondition() {
  if (_toCondition == nullptr) {
    buildToCondition();
  }
  TRI_ASSERT(_toCondition != nullptr);
  swapSides(_toCondition);
  return _modCondition;
}

void Graph::insertVertexCollections(VPackSlice& arr) {
  TRI_ASSERT(arr.isArray());
  for (auto const& c : VPackArrayIterator(arr)) {
    TRI_ASSERT(c.isString());
    addVertexCollection(c.copyString());
  }
}

std::unordered_set<std::string> const& Graph::vertexCollections() const {
  return _vertexColls;
}

std::unordered_set<std::string> const& Graph::edgeCollections() const {
  return _edgeColls;
}

void Graph::addEdgeCollection(std::string const& name) {
  _edgeColls.insert(name);
}

void Graph::addVertexCollection(std::string const& name) {
  _vertexColls.insert(name);
}

void Graph::toVelocyPack(VPackBuilder& builder, bool verbose) const {
  VPackObjectBuilder guard(&builder);

  if (!_vertexColls.empty()) {
    builder.add(VPackValue("vertexCollectionNames"));
    VPackArrayBuilder guard2(&builder);
    for (auto const& cn : _vertexColls) {
      builder.add(VPackValue(cn));
    }
  }

  if (!_edgeColls.empty()) {
    builder.add(VPackValue("edgeCollectionNames"));
    VPackArrayBuilder guard2(&builder);
    for (auto const& cn : _edgeColls) {
      builder.add(VPackValue(cn));
    }
  }
}

Graph::Graph(VPackSlice const& slice) : _vertexColls(), _edgeColls() {
  if (slice.hasKey(_attrEdgeDefs)) {
    auto edgeDefs = slice.get(_attrEdgeDefs);

    for (auto const& def : VPackArrayIterator(edgeDefs)) {
      TRI_ASSERT(def.isObject());
      try {
        std::string eCol = arangodb::basics::VelocyPackHelper::getStringValue(
          def, "collection", "");
        addEdgeCollection(eCol);
      } catch (...) {
        THROW_ARANGO_EXCEPTION_MESSAGE(TRI_ERROR_GRAPH_INVALID_GRAPH, "didn't find 'collection' in the graph definition");
      }
      // TODO what if graph is not in a valid format any more
      try {
        VPackSlice tmp = def.get("from");
        insertVertexCollections(tmp);
      } catch (...) {
        THROW_ARANGO_EXCEPTION_MESSAGE(TRI_ERROR_GRAPH_INVALID_GRAPH, "didn't find from-collection in the graph definition");
      }
      try {
        VPackSlice tmp = def.get("to");
        insertVertexCollections(tmp);
      } catch (...) {
        THROW_ARANGO_EXCEPTION_MESSAGE(TRI_ERROR_GRAPH_INVALID_GRAPH, "didn't find to-collection in the graph definition");
      }
    }
  }
  if (slice.hasKey(_attrOrphans)) {
    auto orphans = slice.get(_attrOrphans);
    insertVertexCollections(orphans);
  }
}

void Graph::enhanceEngineInfo(VPackBuilder&) const {
}
