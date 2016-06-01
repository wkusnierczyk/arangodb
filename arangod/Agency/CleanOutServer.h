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
/// @author Kaveh Vahedipour
////////////////////////////////////////////////////////////////////////////////

#ifndef ARANGOD_CONSENSUS_CLEAN_OUT_SERVER_H
#define ARANGOD_CONSENSUS_CLEAN_OUT_SERVER_H 1

#include "Job.h"
#include "Supervision.h"

namespace arangodb {
namespace consensus {

struct CleanOutServer : public Job {
  
  CleanOutServer(Node const& snapshot, Agent* agent, std::string const& jobId,
                 std::string const& creator, std::string const& prefix,
                 std::string const& server);
  
  virtual ~CleanOutServer();
  
  virtual unsigned status() const override;
  virtual bool create() const override;
  virtual bool start() const override;
  
  // Check if all shards' replication factors can be satisfied after clean out.
  bool checkFeasibility() const;
  bool scheduleMoveShards() const;

  std::string _server;
  
};

}}

#endif